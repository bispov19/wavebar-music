// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Linha de volume do card: [ícone]  ━━━━━━●────  [42%]
//
// Controla o volume DO APP que está tocando (o mesmo de Configurações › Som ›
// Níveis de volume), não o volume geral — esse continua no painel do GNOME.
// Usa a conexão com o PipeWire/PulseAudio que o Shell já mantém
// (Volume.getMixerControl() é um singleton), então não abrimos outra.
// Quais fluxos são do app: ver appStreams.js.
// Mudanças feitas por fora (o próprio app, pavucontrol, Configurações)
// chegam pelos sinais notify::volume / notify::is-muted dos fluxos.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {describePlayer, pickStreams, readOwners} from './appStreams.js';
import {isCancelled} from './coverArt.js';

const ALLOW_AMPLIFIED_KEY = 'allow-volume-above-100-percent';
const UNMUTE_DEFAULT_VOLUME = 0.25; // desmutar com volume 0 → volta em 25% (como o GNOME)
const PERCENT_HIDE_MS = 1000;       // a porcentagem some 1 s depois do último ajuste
const PERCENT_FADE_MS = 150;
const REFRESH_DELAY_MS = 150;       // junta vários "fluxo entrou/saiu" numa busca só
const RETRY_DELAY_MS = 500;         // fluxo novo que o pactl ainda não viu
const MAX_RETRIES = 2;

const ICONS = [
    'audio-volume-muted-symbolic',
    'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic',
    'audio-volume-high-symbolic',
    'audio-volume-overamplified-symbolic',
];

export const VolumeControl = GObject.registerClass({
    GTypeName: 'WavebarMusicVolumeControl',
}, class VolumeControl extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'wavebar-music-volume',
            x_expand: true,
        });

        this._player = null;
        this._playerKey = null;
        this._streams = [];           // fluxos de áudio (Gvc.MixerSinkInput) do player atual
        this._lastLevels = new Map(); // busName → {level, muted}: mostrado com o app sem áudio
        this._dragging = false;
        this._applying = false;       // aplicando o valor do slider no app (ver _onSliderChanged)
        this._hidePercentId = 0;
        this._refreshId = 0;
        this._retries = 0;
        this._cancellable = null;

        this._muteButton = new St.Button({
            style_class: 'wavebar-music-icon-button wavebar-music-volume-icon',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: ICONS[0]}),
        });
        this._muteButton.connect('clicked', () => this._toggleMute());

        this._slider = new Slider(0);
        this._slider.add_style_class_name('wavebar-music-volume-slider');
        this._slider.accessible_name = 'Volume do app';
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._sliderChangedId = this._slider.connect('notify::value',
            () => this._onSliderChanged());
        // Durante o arraste, ecos atrasados do servidor de áudio não mexem
        // no puxador (senão ele "tremeria" sob o mouse).
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
            this._showPercent();
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            this._updateFromStreams();
            this._scheduleHidePercent();
        });

        // Ocupa sempre o mesmo espaço (só a opacidade muda): o slider não
        // muda de largura quando a porcentagem aparece.
        this._percent = new St.Label({
            style_class: 'wavebar-music-volume-percent',
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
        });

        this.add_child(this._muteButton);
        this.add_child(this._slider);
        this.add_child(this._percent);

        this._soundSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});
        this._soundSettings.connectObject(`changed::${ALLOW_AMPLIFIED_KEY}`,
            () => this._updateMaximum(), this);

        // Fluxos entram e saem quando apps começam/param de tocar.
        this._control = Volume.getMixerControl();
        this._control.connectObject(
            'state-changed', () => this._queueRefresh(),
            'stream-added', () => this._queueRefresh(),
            'stream-removed', (_c, id) => {
                if (this._streams.some(s => s.get_id() === id))
                    this._setStreams(this._streams.filter(s => s.get_id() !== id));
                this._queueRefresh();
            }, this);

        this._updateMaximum();
        this._setStreams([]);

        this.connect('destroy', () => this._onDestroy());
    }

    // ---------- player → fluxos de áudio ----------

    /**
     * Player mostrado no card (null ao fechar: para de procurar fluxos).
     * O card chama a cada atualização; só refaz a busca se o player mudou
     * ou se o PID/app dele ficaram conhecidos agora.
     */
    setPlayer(player) {
        const key = player
            ? `${player.busName}|${player.pid}|${player.app?.get_id() ?? ''}` : null;
        if (key === this._playerKey)
            return;
        const samePlayer = player && player === this._player;
        this._playerKey = key;
        this._player = player;
        this._cancelRefresh();

        if (!player) {
            this._setStreams([]);
            this._hidePercentNow();
            return;
        }
        this._slider.accessible_name = `Volume de ${player.displayName}`;
        // Trocou de player: solta os fluxos do anterior na hora (nada de
        // mexer no app errado) e mostra o último volume conhecido deste.
        if (!samePlayer)
            this._setStreams([]);
        this._retries = 0;
        this._refresh();
    }

    _queueRefresh(delay = REFRESH_DELAY_MS) {
        if (!this._player || this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRefresh() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    _refresh() {
        this._findStreams().catch(e =>
            console.error('[Wavebar Music] Erro ao procurar o áudio do app:', e));
    }

    async _findStreams() {
        const player = this._player;
        if (!player)
            return;
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        const ready = this._control.get_state() === Gvc.MixerControlState.READY;
        const inputs = ready
            ? this._control.get_sink_inputs().filter(s => !s.is_event_stream) : []; // (propriedade, não método)

        let owners = null;
        if (inputs.length > 0) {
            try {
                owners = await readOwners(cancellable);
            } catch (e) {
                if (isCancelled(e) || cancellable.is_cancelled())
                    return;
                // Sem pactl: seguimos só com os nomes que o Gvc informa.
                console.log(`[Wavebar Music] Volume do app: pactl indisponível (${e.message})`);
            }
        }
        if (cancellable.is_cancelled() || player !== this._player)
            return;
        this._cancellable = null;

        let incomplete = false;
        const entries = inputs.map(stream => {
            const owner = owners?.get(stream.get_index());
            if (owners && !owner)
                incomplete = true; // o pactl ainda não conhecia este fluxo
            return {
                stream,
                pid: owner?.pid ?? 0,
                names: [...owner?.names ?? [], stream.get_application_id(), stream.get_icon_name()]
                    .filter(Boolean),
            };
        });
        this._setStreams(pickStreams(entries, describePlayer(player)));

        if (incomplete && this._retries < MAX_RETRIES) {
            this._retries++;
            this._queueRefresh(RETRY_DELAY_MS);
        } else {
            this._retries = 0;
        }
    }

    _setStreams(streams) {
        const same = streams.length === this._streams.length &&
            streams.every((s, i) => s === this._streams[i]);
        if (!same) {
            for (const s of this._streams)
                s.disconnectObject(this);
            this._streams = streams;
            for (const s of streams) {
                s.connectObject(
                    'notify::volume', () => this._updateFromStreams(),
                    'notify::is-muted', () => this._updateFromStreams(), this);
            }
        }

        // Sem fluxo (app pausado e sem áudio aberto, ou player sem áudio local):
        // a linha continua no lugar, mas apagada e sem reagir.
        const active = streams.length > 0;
        this._slider.reactive = this._slider.can_focus = active;
        this._muteButton.reactive = this._muteButton.can_focus = active;
        if (!active)
            this._dragging = false;
        this._updateFromStreams();
    }

    // Fluxo de referência para mostrar o nível: o que está tocando, se houver.
    get _primary() {
        return this._streams.find(s => s.get_state() === Gvc.MixerStreamState.RUNNING) ??
            this._streams[0] ?? null;
    }

    get _maxNorm() {
        return this._control.get_vol_max_norm();
    }

    // Volume acima de 100% só se o usuário ativou em Configurações › Som.
    _updateMaximum() {
        const amplified = this._soundSettings.get_boolean(ALLOW_AMPLIFIED_KEY);
        this._slider.maximum_value = amplified
            ? this._control.get_vol_max_amplified() / this._maxNorm : 1;
        this._slider.clearMarks();
        if (amplified)
            this._slider.addMark(1); // "gruda" em 100% ao passar por ele
        this._updateFromStreams();
    }

    // App → interface (sem disparar _onSliderChanged).
    _updateFromStreams() {
        const stream = this._primary;
        const busName = this._player?.busName;
        let state;
        if (stream) {
            state = {level: stream.volume / this._maxNorm, muted: stream.is_muted};
            if (busName)
                this._lastLevels.set(busName, state);
        } else {
            state = this._lastLevels.get(busName) ?? {level: 1, muted: false};
        }
        const {level, muted} = state;

        if (!this._dragging && !this._applying) {
            this._slider.block_signal_handler(this._sliderChangedId);
            this._slider.value = muted ? 0 : level;
            this._slider.unblock_signal_handler(this._sliderChangedId);
            this._percent.text = `${Math.round(muted ? 0 : level * 100)}%`;
        }

        // 0 = mudo; 1–3 = baixo/médio/alto (terços de 100%); 4 = acima de 100%.
        let n = 0;
        if (!muted && level > 0)
            n = Math.min(Math.max(Math.ceil(3 * level), 1), ICONS.length - 1);
        this._muteButton.child.icon_name = ICONS[n];
        this._muteButton.accessible_name = muted ? 'Ativar som do app' : 'Silenciar app';
    }

    // ---------- interface → app ----------

    // Chamado a cada movimento do slider (arraste, roda do mouse, setas):
    // aplica na hora em todos os fluxos do app (ex.: várias abas tocando).
    _onSliderChanged() {
        if (this._streams.length === 0 || this._applying)
            return;

        // Trava: set_volume() avisa NA HORA (notify::volume) e, com o app
        // ainda mudo, _updateFromStreams poria o slider de volta em 0 — e esse
        // 0 seria aplicado em seguida. Enquanto aplicamos, o slider é a fonte.
        this._applying = true;
        try {
            this._applyToStreams(this._slider.value * this._maxNorm);
        } finally {
            this._applying = false;
        }

        this._percent.text = `${Math.round(this._slider.value * 100)}%`;
        this._showPercent();
        if (!this._dragging)
            this._scheduleHidePercent();
    }

    _applyToStreams(volume) {
        for (const stream of this._streams) {
            const wasMuted = stream.is_muted;
            let changed;
            if (volume < 1) {
                // Arrastou até o fim: zera e silencia (o ícone vira "mudo").
                changed = stream.set_volume(0);
                if (!wasMuted)
                    stream.change_is_muted(true);
            } else {
                changed = stream.set_volume(volume);
                if (wasMuted)
                    stream.change_is_muted(false);
            }
            if (changed)
                stream.push_volume();
        }
    }

    _toggleMute() {
        const primary = this._primary;
        if (!primary)
            return;
        const muted = primary.is_muted;
        for (const stream of this._streams) {
            // Desmutar com volume 0 deixaria tudo em silêncio: sobe para 25%.
            if (muted && stream.volume === 0) {
                stream.set_volume(UNMUTE_DEFAULT_VOLUME * this._maxNorm);
                stream.push_volume();
            }
            stream.change_is_muted(!muted);
        }
    }

    // ---------- porcentagem ----------

    _showPercent() {
        this._clearHideTimer();
        this._percent.ease({opacity: 255, duration: PERCENT_FADE_MS});
    }

    _scheduleHidePercent() {
        this._clearHideTimer();
        this._hidePercentId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PERCENT_HIDE_MS, () => {
            this._hidePercentId = 0;
            this._percent.ease({opacity: 0, duration: PERCENT_FADE_MS});
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearHideTimer() {
        if (this._hidePercentId) {
            GLib.source_remove(this._hidePercentId);
            this._hidePercentId = 0;
        }
    }

    // Card fechou: some com a porcentagem para não reaparecer "presa".
    _hidePercentNow() {
        this._clearHideTimer();
        this._percent.remove_all_transitions();
        this._percent.opacity = 0;
    }

    _onDestroy() {
        this._cancelRefresh();
        this._clearHideTimer();
        for (const s of this._streams)
            s.disconnectObject(this);
        this._streams = [];
        this._player = null;
        // O mixer é do Shell (compartilhado): só desconectamos, nunca fechamos.
        this._control.disconnectObject(this);
        this._soundSettings.disconnectObject(this);
    }
});
