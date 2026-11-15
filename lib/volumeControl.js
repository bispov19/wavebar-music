// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Linha de volume do card: [ícone]  ━━━━━━●────  [42%]
//
// Controla o volume da SAÍDA PADRÃO do sistema (o mesmo do painel do GNOME).
// Usa a conexão com o PipeWire/PulseAudio que o Shell já mantém
// (Volume.getMixerControl() é um singleton), então não abrimos outra.
// Mudanças feitas por fora (teclas de volume, menu do sistema, pavucontrol)
// chegam pelos sinais notify::volume / notify::is-muted da stream.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

const ALLOW_AMPLIFIED_KEY = 'allow-volume-above-100-percent';
const UNMUTE_DEFAULT_VOLUME = 0.25; // desmutar com volume 0 → volta em 25% (como o GNOME)
const PERCENT_HIDE_MS = 1000;       // a porcentagem some 1 s depois do último ajuste
const PERCENT_FADE_MS = 150;

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

        this._stream = null;
        this._dragging = false;
        this._hidePercentId = 0;

        this._muteButton = new St.Button({
            style_class: 'wavebar-music-icon-button wavebar-music-volume-icon',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: ICONS[0]}),
        });
        this._muteButton.connect('clicked', () => this._toggleMute());

        this._slider = new Slider(0);
        this._slider.add_style_class_name('wavebar-music-volume-slider');
        this._slider.accessible_name = 'Volume';
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
            this._updateFromStream();
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

        this._control = Volume.getMixerControl();
        this._control.connectObject(
            'state-changed', () => this._readSink(),
            'default-sink-changed', () => this._readSink(), this);

        this._updateMaximum();
        this._readSink();

        this.connect('destroy', () => this._onDestroy());
    }

    // ---------- stream (saída padrão) ----------

    _readSink() {
        const ready = this._control.get_state() === Gvc.MixerControlState.READY;
        this._setStream(ready ? this._control.get_default_sink() : null);
    }

    _setStream(stream) {
        if (stream === this._stream)
            return;
        this._stream?.disconnectObject(this);
        this._stream = stream;
        stream?.connectObject(
            'notify::volume', () => this._updateFromStream(),
            'notify::is-muted', () => this._updateFromStream(), this);

        // Sem saída de áudio (ou ainda conectando): a linha some.
        this.visible = !!stream;
        this._updateFromStream();
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
        this._updateFromStream();
    }

    // Sistema → interface (sem disparar _onSliderChanged).
    _updateFromStream() {
        const stream = this._stream;
        if (!stream)
            return;
        const muted = stream.is_muted;
        const level = stream.volume / this._maxNorm;

        if (!this._dragging) {
            this._slider.block_signal_handler(this._sliderChangedId);
            this._slider.value = muted ? 0 : level;
            this._slider.unblock_signal_handler(this._sliderChangedId);
        }

        // 0 = mudo; 1–3 = baixo/médio/alto (terços de 100%); 4 = acima de 100%.
        let n = 0;
        if (!muted && stream.volume > 0)
            n = Math.min(Math.max(Math.ceil(3 * level), 1), ICONS.length - 1);
        this._muteButton.child.icon_name = ICONS[n];
        this._muteButton.accessible_name = muted ? 'Ativar som' : 'Silenciar';

        if (!this._dragging)
            this._percent.text = `${Math.round(muted ? 0 : level * 100)}%`;
    }

    // ---------- interface → sistema ----------

    // Chamado a cada movimento do slider (arraste, roda do mouse, setas):
    // aplica na hora, como o slider do menu do sistema.
    _onSliderChanged() {
        const stream = this._stream;
        if (!stream)
            return;

        const value = this._slider.value;
        const volume = value * this._maxNorm;
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

        this._percent.text = `${Math.round(value * 100)}%`;
        this._showPercent();
        if (!this._dragging)
            this._scheduleHidePercent();
    }

    _toggleMute() {
        const stream = this._stream;
        if (!stream)
            return;
        const muted = stream.is_muted;
        // Desmutar com volume 0 deixaria tudo em silêncio: sobe para 25%.
        if (muted && stream.volume === 0) {
            stream.set_volume(UNMUTE_DEFAULT_VOLUME * this._maxNorm);
            stream.push_volume();
        }
        stream.change_is_muted(!muted);
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

    /** Card fechou: some com a porcentagem para não reaparecer "presa". */
    reset() {
        this._clearHideTimer();
        this._percent.remove_all_transitions();
        this._percent.opacity = 0;
    }

    _onDestroy() {
        this._clearHideTimer();
        this._stream?.disconnectObject(this);
        this._stream = null;
        // O mixer é do Shell (compartilhado): só desconectamos, nunca fechamos.
        this._control.disconnectObject(this);
        this._soundSettings.disconnectObject(this);
    }
});
