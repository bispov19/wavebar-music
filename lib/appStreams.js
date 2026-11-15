// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
//
// Descobre quais fluxos de áudio ("sink inputs" do PipeWire/PulseAudio)
// pertencem a um player MPRIS — para o card mexer no volume DO APP, e não
// no volume geral.
//
// O Gvc (biblioteca de áudio do Shell) não informa o PID de cada fluxo,
// então perguntamos ao `pactl`: o fluxo traz o PID (clientes PulseAudio) ou
// o "client" dele traz (clientes PipeWire nativos, como o mpv).
// Ordem de confiança:
//   1. o fluxo vem do processo que publicou o MPRIS, ou de um FILHO dele
//      (Chrome, Firefox e apps Electron tocam o áudio num subprocesso);
//   2. o fluxo vem de um processo das janelas do app (Flatpak: o MPRIS chega
//      pelo xdg-dbus-proxy, cujo PID não é o do app);
//   3. nomes iguais (sem pactl, ou PIDs que não batem).
// Só as partes com GLib/Gio ficam aqui; nada de Shell — dá para testar com gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {busBaseName} from './mpris.js';

const MAX_DEPTH = 32;   // limite ao subir na árvore de processos
// Nomes que não identificam um app (ex.: com.spotify.Client → "client").
const GENERIC_NAMES = new Set([
    'chromium', 'electron', 'client', 'desktop', 'app', 'player', 'browser',
    'applicationsmultimedia',
]);

/** "Google Chrome" → "googlechrome"; "spotify.desktop" → "spotify". */
export function normalizeName(name) {
    return String(name ?? '').toLowerCase().replace(/\.desktop$/, '').replace(/[^a-z0-9]/g, '');
}

function toPid(value) {
    const pid = parseInt(value, 10);
    return pid > 0 ? pid : 0;
}

/**
 * Junta a saída de `pactl -f json list sink-inputs` e `... list clients`.
 *
 * @returns {Map<number, {pid: number, names: string[]}>} índice do fluxo → dono
 */
export function parseOwners(inputs, clients) {
    const clientProps = new Map(clients.map(c => [String(c.index), c.properties ?? {}]));
    const owners = new Map();
    for (const input of inputs) {
        const props = input.properties ?? {};
        const client = clientProps.get(String(input.client)) ?? {};
        // Clientes PulseAudio trazem o PID no próprio fluxo; nativos do
        // PipeWire, no client. O pipewire.sec.pid fica por último: num cliente
        // PulseAudio ele é o PID do pipewire-pulse, não o do app.
        const pid = toPid(props['application.process.id']) ||
            toPid(client['application.process.id']) ||
            toPid(client['pipewire.sec.pid']);
        const names = [
            props['application.name'], props['application.process.binary'],
            props['application.id'], props['pipewire.access.portal.app_id'],
            client['application.name'], client['pipewire.access.portal.app_id'],
        ].filter(Boolean);
        owners.set(Number(input.index), {pid, names});
    }
    return owners;
}

/** PID do processo pai, lido de /proc/<pid>/stat (0 se não existir). */
export function parentPid(pid) {
    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        const text = new TextDecoder().decode(bytes);
        // "123 (nome do processo) S 45 …": o nome pode ter espaços e
        // parênteses, então contamos a partir do ÚLTIMO ")".
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        return toPid(fields[1]);
    } catch {
        return 0;
    }
}

/** `pid` é um dos `roots` ou descende de algum deles? */
export function descendsFrom(pid, roots, parentOf = parentPid) {
    for (let depth = 0; pid > 1 && depth < MAX_DEPTH; depth++) {
        if (roots.has(pid))
            return true;
        pid = parentOf(pid);
    }
    return false;
}

/**
 * Escolhe os fluxos do player.
 *
 * @param {{stream: *, pid: number, names: string[]}[]} entries - fluxos de áudio
 * @param {{pid: number, appPids: number[], names: string[]}} player
 * @param {Function} parentOf - injetável nos testes
 * @returns {*[]} os `stream` escolhidos (vazio se nenhum)
 */
export function pickStreams(entries, player, parentOf = parentPid) {
    const memo = new Map();
    const cachedParent = pid => {
        if (!memo.has(pid))
            memo.set(pid, parentOf(pid));
        return memo.get(pid);
    };

    const tiers = [
        new Set([player.pid].filter(p => p > 0)),
        new Set(player.appPids.filter(p => p > 0)),
    ];
    for (const roots of tiers) {
        if (roots.size === 0)
            continue;
        const found = entries.filter(e => e.pid > 0 && descendsFrom(e.pid, roots, cachedParent));
        if (found.length > 0)
            return found.map(e => e.stream);
    }

    const wanted = new Set(player.names.map(normalizeName)
        .filter(n => n && !GENERIC_NAMES.has(n)));
    return entries
        .filter(e => e.names.some(n => wanted.has(normalizeName(n))))
        .map(e => e.stream);
}

/** Dados do player usados na busca (separado para os testes não precisarem do Shell). */
export function describePlayer(player) {
    const appId = player.app?.get_id() ?? '';
    return {
        pid: player.pid ?? 0,
        appPids: player.app?.get_pids() ?? [],
        names: [
            player.identity, player.app?.get_name(), appId,
            appId.replace(/\.desktop$/, '').split('.').pop(), // org.mozilla.firefox → firefox
            busBaseName(player.busName),
        ].filter(Boolean),
    };
}

function runPactl(args, cancellable) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(['pactl', '-f', 'json', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            reject(e); // pactl não instalado
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                if (!p.get_successful())
                    throw new Error(`pactl ${args.join(' ')} terminou com erro`);
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Lê os donos (PID/nomes) de todos os fluxos. Lança erro se o pactl falhar. */
export async function readOwners(cancellable) {
    const [inputs, clients] = await Promise.all([
        runPactl(['list', 'sink-inputs'], cancellable),
        runPactl(['list', 'clients'], cancellable),
    ]);
    return parseOwners(inputs, clients);
}
