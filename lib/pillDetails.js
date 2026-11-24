// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Parte "expandida" da pílula do painel: capa redonda + "Título · Artista".
//
// Quem decide QUANDO mostrar (e anima a largura) é o panelIndicator.js; este
// arquivo só cuida do conteúdo:
//   - capa em miniatura (mesmo CoverArtLoader/cache do card);
//   - texto numa St.ScrollView sem barra: se não couber, rola sozinho de um
//     lado para o outro (marquee), e o "-st-hfade-offset" da ScrollView
//     esmaece só a borda que tem texto escondido.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {isCancelled} from './coverArt.js';
import {splitArtistTitle} from './lrc.js';

// Marquee: pausa no início, vai até o fim devagar, pausa, volta mais rápido.
const MARQUEE_SPEED = 28;          // px/s (lógicos) indo
const MARQUEE_RETURN_SPEED = 110;  // px/s voltando
const MARQUEE_START_PAUSE_MS = 2200;
const MARQUEE_END_PAUSE_MS = 1500;
const MARQUEE_RESET_MS = 200;      // volta ao início quando o marquee para

export const PillDetails = GObject.registerClass({
    GTypeName: 'WavebarMusicPillDetails',
}, class PillDetails extends St.BoxLayout {
    _init(covers) {
        super._init({
            style_class: 'wavebar-music-pill-details',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        this._covers = covers;
        this._coverCancellable = null;
        this._artUrl = null;      // última capa pedida (null = nenhuma ainda)
        this._pendingArtUrl = ''; // capa da faixa atual, carregada só se precisar
        this._active = false;
        this._playing = false;
        this._scrollEnabled = true;
        this._frozen = false;
        this._marqueeRange = -1;  // distância (px) do marquee em andamento; -1 = parado

        // Capa: círculo com a arte do player como fundo, ou o ícone de música.
        this._cover = new St.Bin({
            style_class: 'wavebar-music-pill-cover wavebar-music-no-cover',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                style_class: 'wavebar-music-pill-cover-icon',
                icon_name: 'audio-x-generic-symbolic',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        this.add_child(this._cover);

        // Texto. A ScrollView com política EXTERNAL não mostra barra, mas
        // deixa o conteúdo ter a largura natural (maior que a área visível)
        // e rolar pelo hadjustment — que é o que o marquee anima.
        this._label = new St.Label({
            style_class: 'wavebar-music-pill-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._label);
        this._view = new St.ScrollView({
            style_class: 'wavebar-music-pill-text',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            enable_mouse_scrolling: false, // a roda do mouse no painel não mexe no texto
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: box,
        });
        this.add_child(this._view);

        // "changed" = mudou o tamanho do texto ou da área visível.
        this._hadj = this._view.hadjustment;
        this._hadj.connectObject('changed', () => this._syncMarquee(), this);
        this.connectObject('notify::mapped', () => this._syncMarquee(), this);
        this._stSettings = St.Settings.get();
        this._stSettings.connectObject('notify::enable-animations',
            () => this._syncMarquee(), this);

        this.connect('destroy', () => this._onDestroy());
    }

    /** Mostra a capa (círculo) à esquerda do texto. */
    set showCover(show) {
        this._cover.visible = show;
        this._maybeLoadCover();
    }

    /** Rola sozinho o texto que não cabe. Desligado: só o esmaecimento na borda. */
    set scrollEnabled(enabled) {
        this._scrollEnabled = enabled;
        this._syncMarquee();
    }

    /** Pausado: o marquee para (nada de animação gastando quadros à toa). */
    set playing(playing) {
        this._playing = playing;
        this._syncMarquee();
    }

    /**
     * Há chance de a pílula expandir (modo expandido ou uma das opções de
     * expandir ligada)? Só então baixamos a capa — no compacto puro, não.
     */
    set active(active) {
        this._active = active;
        this._maybeLoadCover();
    }

    /**
     * Enquanto a largura da pílula anima, a área visível muda a cada quadro:
     * congelamos o marquee e o retomamos quando a largura assentar.
     */
    set frozen(frozen) {
        if (this._frozen === frozen)
            return;
        this._frozen = frozen;
        this._syncMarquee();
    }

    setTrack(metadata) {
        // Mesmo tratamento do card: "Artista - Música (Official Video)" → limpo.
        const shown = splitArtistTitle(metadata.title, metadata.artists.join(', '));
        const title = shown.title || metadata.title;
        const artist = shown.artist;

        const esc = s => GLib.markup_escape_text(s, -1);
        let markup = `<b>${esc(title)}</b>`;
        if (artist)
            markup += `<span fgalpha="70%">  ·  ${esc(artist)}</span>`;
        if (markup !== this._markup) {
            this._markup = markup;
            this._label.clutter_text.set_markup(markup);
            // Texto novo começa do início (sem esperar o "changed", que não
            // vem se a largura por acaso for a mesma).
            this._stopMarquee(false);
            this._syncMarquee();
        }

        this._pendingArtUrl = metadata.artUrl;
        this._maybeLoadCover();
    }

    // ---------- Capa ----------

    _maybeLoadCover() {
        if (!this._active || !this._cover.visible || this._pendingArtUrl === this._artUrl)
            return;
        this._artUrl = this._pendingArtUrl;
        this._loadCover(this._artUrl);
    }

    async _loadCover(url) {
        this._coverCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._coverCancellable = cancellable;

        // Troca de faixa: some a capa antiga na hora (nada de capa errada
        // enquanto a nova baixa).
        this._setCover(null);
        if (!url)
            return;

        let path = null;
        try {
            path = await this._covers.load(url, cancellable);
        } catch (e) {
            if (isCancelled(e))
                return;
        }
        if (!cancellable.is_cancelled())
            this._setCover(path);
    }

    _setCover(path) {
        if (path) {
            // filename_to_uri escapa espaços e aspas: seguro dentro de url("…").
            this._cover.style = `background-image: url("${GLib.filename_to_uri(path, null)}");`;
            this._cover.remove_style_class_name('wavebar-music-no-cover');
            this._cover.child.visible = false;
        } else {
            this._cover.style = null;
            this._cover.add_style_class_name('wavebar-music-no-cover');
            this._cover.child.visible = true;
        }
    }

    // ---------- Marquee ----------
    //
    // Sem timers: cada trecho é um ease() do hadjustment com "delay" fazendo
    // o papel da pausa, e o onComplete encadeia o próximo trecho. A transição
    // anda no relógio de quadros do compositor e é removida ao parar.

    _range() {
        return Math.max(0, this._hadj.upper - this._hadj.page_size);
    }

    _canMarquee() {
        return this._scrollEnabled && this._playing && !this._frozen &&
            this.mapped && this._stSettings.enable_animations && this._range() >= 1;
    }

    _syncMarquee() {
        if (!this._canMarquee()) {
            this._stopMarquee(true);
            return;
        }
        // "changed" também chega sem mudança real: só reinicia se a distância mudou.
        const range = this._range();
        if (Math.abs(range - this._marqueeRange) < 0.5)
            return;
        this._stopMarquee(false);
        this._marqueeRange = range;
        this._marqueeStep(true);
    }

    _marqueeStep(forward) {
        // Guarda importante: com o ator desmapeado ou animações desligadas o
        // ease() termina NA HORA e chamaria o onComplete de novo, em loop.
        if (this._marqueeRange < 0 || !this._canMarquee()) {
            this._stopMarquee(true);
            return;
        }

        const range = this._range();
        this._marqueeRange = range;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const speed = (forward ? MARQUEE_SPEED : MARQUEE_RETURN_SPEED) * scale;
        this._hadj.ease(forward ? range : 0, {
            duration: Math.max(1, range / speed * 1000),
            delay: forward ? MARQUEE_START_PAUSE_MS : MARQUEE_END_PAUSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => this._marqueeStep(!forward),
        });
    }

    // Para o marquee; `smooth` volta ao início com uma animação curta
    // (sem onComplete: não encadeia nada).
    _stopMarquee(smooth) {
        const wasRunning = this._marqueeRange >= 0;
        this._marqueeRange = -1;
        // Já parado e voltando ao início: deixa terminar (o "changed" chega a
        // cada quadro enquanto a largura anima e reiniciaria a volta sempre).
        if (smooth && !wasRunning && this._hadj.get_transition('value'))
            return;
        this._hadj.remove_transition('value');
        if (this._hadj.value === 0)
            return;
        if (smooth && this.mapped)
            this._hadj.ease(0, {duration: MARQUEE_RESET_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this._hadj.value = 0;
    }

    _onDestroy() {
        this._coverCancellable?.cancel();
        this._coverCancellable = null;
        this._marqueeRange = -1;
        this._hadj.remove_transition('value');
        this._hadj.disconnectObject(this);
        this._stSettings.disconnectObject(this);
        this._stSettings = null;
        this._covers = null;
    }
});
