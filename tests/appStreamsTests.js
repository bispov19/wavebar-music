// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
import {descendsFrom, normalizeName, parseOwners, pickStreams} from '../lib/appStreams.js';

// Árvore de processos de mentira: filho → pai.
const PARENTS = {
    1100: 1000,  // Chrome: zygote ← navegador (1000, dono do MPRIS)
    1200: 1100,  // serviço de áudio ← zygote
    2000: 1,     // Spotify
    3000: 1,     // outro app qualquer
    4100: 4000,  // app Flatpak: áudio ← processo das janelas
};
const parentOf = pid => PARENTS[pid] ?? 1;

const player = (pid, appPids = [], names = []) => ({pid, appPids, names});

export function register({test, assert, assertEqual}) {
    test('normalizeName', () => {
        assertEqual(normalizeName('Google Chrome'), 'googlechrome');
        assertEqual(normalizeName('spotify.desktop'), 'spotify');
        assertEqual(normalizeName(null), '');
    });

    test('descendsFrom sobe a árvore e para no init', () => {
        assert(descendsFrom(1200, new Set([1000]), parentOf), 'neto não reconhecido');
        assert(descendsFrom(1000, new Set([1000]), parentOf), 'o próprio PID');
        assert(!descendsFrom(3000, new Set([1000]), parentOf), 'processo alheio aceito');
        assert(!descendsFrom(0, new Set([1000]), parentOf), 'PID 0 aceito');
    });

    test('parseOwners: PID do fluxo, depois do client; sec.pid (pipewire-pulse) por último', () => {
        const owners = parseOwners(
            [
                // cliente PulseAudio: o client é o pipewire-pulse
                {index: 10, client: '5', properties: {'application.name': 'Firefox', 'application.process.id': '7'}},
                // cliente PipeWire nativo: PID só no client
                {index: 11, client: '6', properties: {}},
                {index: 12, client: '99', properties: {'application.process.id': '42'}},
                {index: 13, client: '8', properties: {}},
            ],
            [
                {index: 5, properties: {'pipewire.sec.pid': '700'}},
                {index: 6, properties: {'application.process.id': '800', 'application.name': 'mpv'}},
                {index: 8, properties: {'pipewire.sec.pid': '900'}},
            ]);
        assertEqual(owners.get(10), {pid: 7, names: ['Firefox']});
        assertEqual(owners.get(11), {pid: 800, names: ['mpv']});
        assertEqual(owners.get(12).pid, 42);
        assertEqual(owners.get(13).pid, 900);
    });

    const entries = [
        {stream: 'chrome-audio', pid: 1200, names: ['Google Chrome']},
        {stream: 'spotify', pid: 2000, names: ['Spotify']},
        {stream: 'outro', pid: 3000, names: ['Outro']},
        {stream: 'flatpak', pid: 4100, names: ['Deezer']},
    ];

    test('pickStreams: fluxo de subprocesso do navegador', () => {
        assertEqual(pickStreams(entries, player(1000, [], ['Google Chrome']), parentOf), ['chrome-audio']);
    });

    test('pickStreams: Flatpak (PID do MPRIS é o proxy) cai nos PIDs das janelas', () => {
        assertEqual(pickStreams(entries, player(9999, [4000], ['Deezer']), parentOf), ['flatpak']);
    });

    test('pickStreams: sem PID que bata, usa o nome', () => {
        assertEqual(pickStreams(entries, player(0, [], ['spotify']), parentOf), ['spotify']);
    });

    test('pickStreams: nomes genéricos não casam; nada encontrado → vazio', () => {
        const generic = [{stream: 'x', pid: 0, names: ['Chromium']}];
        assertEqual(pickStreams(generic, player(0, [], ['chromium']), parentOf), []);
        assertEqual(pickStreams(entries, player(5555, [], ['VLC']), parentOf), []);
    });

    test('pickStreams: PID vence nome (não pega outro app de mesmo nome)', () => {
        const twins = [
            {stream: 'meu', pid: 2000, names: ['Player']},
            {stream: 'outro', pid: 3000, names: ['Spotify']},
        ];
        assertEqual(pickStreams(twins, player(2000, [], ['Spotify']), parentOf), ['meu']);
    });
}
