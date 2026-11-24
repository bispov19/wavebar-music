// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Parte "expandida" da pílula do painel: capa redonda + "Título · Artista".
//
// Quem decide QUANDO mostrar (e anima a largura) é o panelIndicator.js; este
// arquivo só cuida do conteúdo:
//   - capa em miniatura (mesmo CoverArtLoader/cache do card);
//   - texto numa "janela" que recorta; se não couber, rola sozinho (marquee).
//
// Por que não St.ScrollView? Ela desloca o conteúdo em PIXELS INTEIROS: em
// velocidade baixa o texto anda "aos degraus". Aqui o texto se move por
// translation_x (subpixel, no relógio de quadros do compositor) e o
// esmaecimento das bordas é um shader nosso, que acompanha o movimento.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {isCancelled} from './coverArt.js';
import {splitArtistTitle} from './lrc.js';

// Marquee: pausa no início → desliza devagar até o fim → pausa → some
// suavemente, reaparece no início (sem "voltar correndo") → recomeça.
const MARQUEE_SPEED = 22;          // px/s (lógicos)
const MARQUEE_START_PAUSE_MS = 2500;
const MARQUEE_END_PAUSE_MS = 1800;
const MARQUEE_FADE_MS = 450;       // some/reaparece no recomeço
const MARQUEE_RESET_MS = 300;      // volta ao início quando o marquee para
const EDGE_FADE_PX = 16;           // largura do esmaecimento em cada borda

// Esmaece as bordas esquerda/direita do ator (alfa pré-multiplicado: escala
// os 4 canais). fade_left/right (0–1) dizem o quanto cada borda está ligada:
// crescem conforme há texto escondido daquele lado, sem aparecer de repente.
const FADE_DECLARATIONS = `
uniform float fade_left;
uniform float fade_right;
uniform float fade_width;
`;
const FADE_CODE = `
float x = cogl_tex_coord_in[0].x;
float a = mix(1.0, smoothstep(0.0, fade_width, x), fade_left) *
          mix(1.0, smoothstep(0.0, fade_width, 1.0 - x), fade_right);
cogl_color_out *= a;
`;

const EdgeFadeEffect = GObject.registerClass({
    GTypeName: 'WavebarMusicEdgeFadeEffect',
}, class EdgeFadeEffect extends Clutter.ShaderEffect {
    vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, FADE_DECLARATIONS, FADE_CODE);
    }

    /** left/right: 0–1; width: fração da largura do ator. */
    setFade(left, right, width) {
        this.set_uniform_float('fade_left', 1, [left]);
        this.set_uniform_float('fade_right', 1, [right]);
        this.set_uniform_float('fade_width', 1, [width]);
        this.queue_repaint();
    }
});

export const PillDetails = GObject.registerClass({
    GTypeName: 'WavebarMusicPillDetails',
}, class PillDetails extends St.BoxLayout {
    _init(covers) {
        super._init({
            style_class: 'wavebar-music-panel-pill-details',
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
            style_class: 'wavebar-music-panel-pill-cover wavebar-music-no-cover',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                style_class: 'wavebar-music-panel-pill-cover-icon',
                icon_name: 'audio-x-generic-symbolic',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        this.add_child(this._cover);

        // Texto: o rótulo fica com a largura natural (FixedLayout não o
        // espreme nem corta com "…") dentro de uma janela que recorta.
        // min_width 0: a janela pode ser mais estreita que o texto.
        this._label = new St.Label({style_class: 'wavebar-music-panel-pill-label'});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._textClip = new St.Widget({
            style_class: 'wavebar-music-panel-pill-text',
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            min_width: 0,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._textClip.add_child(this._label);
        this._fade = new EdgeFadeEffect();
        this._fade.enabled = false;
        this._textClip.add_effect(this._fade);
        this.add_child(this._textClip);

        // Mudou o tamanho do texto ou da janela → recalcula; translation-x
        // muda a cada quadro do marquee → atualiza o esmaecimento.
        this._textClip.connectObject('notify::allocation', () => this._onGeometryChanged(), this);
        this._label.connectObject(
            'notify::allocation', () => this._onGeometryChanged(),
            'notify::translation-x', () => this._updateFade(), this);
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

    /** Rola sozinho o texto que não cabe. Desligado: só o esmaecimento na borda direita. */
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
    // Sem timers: cada trecho é um ease() do rótulo, com "delay" fazendo o
    // papel da pausa, e o onComplete encadeia o próximo trecho. As transições
    // andam no relógio de quadros do compositor e somem ao parar.

    /** Quanto o texto passa da janela (px); 0 se couber. */
    _range() {
        return Math.max(0, this._label.width - this._textClip.width);
    }

    _onGeometryChanged() {
        this._updateFade();
        this._syncMarquee();
    }

    // Esmaecimento proporcional ao texto escondido de cada lado: ao começar a
    // rolar, a borda esquerda vai aparecendo aos poucos (e a direita some no fim).
    _updateFade() {
        const width = this._textClip.width;
        const range = this._range();
        this._fade.enabled = range >= 1 && width > 0;
        if (!this._fade.enabled)
            return;
        const fadePx = EDGE_FADE_PX * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const shift = -this._label.translation_x;   // 0 … range
        this._fade.setFade(
            Math.min(1, Math.max(0, shift / fadePx)),
            Math.min(1, Math.max(0, (range - shift) / fadePx)),
            Math.min(0.45, fadePx / width));
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
        // Só reinicia se a distância mudou de verdade (a alocação é
        // notificada também sem mudança real).
        const range = this._range();
        if (Math.abs(range - this._marqueeRange) < 0.5)
            return;
        this._stopMarquee(false);
        this._marqueeRange = range;
        this._marqueeScroll();
    }

    // Guarda importante: com o ator desmapeado ou animações desligadas o
    // ease() termina NA HORA e chamaria o onComplete de novo, em loop.
    _marqueeAlive() {
        if (this._marqueeRange >= 0 && this._canMarquee())
            return true;
        this._stopMarquee(true);
        return false;
    }

    // Pausa no início e desliza até o fim. EASE_IN_OUT_SINE: arranca e freia
    // devagar, sem tranco.
    _marqueeScroll() {
        if (!this._marqueeAlive())
            return;
        const range = this._range();
        this._marqueeRange = range;
        const speed = MARQUEE_SPEED * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._label.ease({
            translation_x: -range,
            duration: Math.max(1, range / speed * 1000),
            delay: MARQUEE_START_PAUSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => this._marqueeRestart(),
        });
    }

    // Pausa no fim, some, volta ao início escondido e reaparece.
    _marqueeRestart() {
        if (!this._marqueeAlive())
            return;
        this._label.ease({
            opacity: 0,
            duration: MARQUEE_FADE_MS,
            delay: MARQUEE_END_PAUSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._marqueeAlive())
                    return;
                this._label.translation_x = 0;
                this._label.ease({
                    opacity: 255,
                    duration: MARQUEE_FADE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => this._marqueeScroll(),
                });
            },
        });
    }

    // Para o marquee; `smooth` leva o texto de volta ao início com uma
    // animação curta (sem onComplete: não encadeia nada).
    _stopMarquee(smooth) {
        const wasRunning = this._marqueeRange >= 0;
        this._marqueeRange = -1;
        const label = this._label;
        // Já parado e voltando ao início: deixa terminar (a alocação é
        // notificada a cada quadro enquanto a largura da pílula anima).
        if (smooth && !wasRunning && label.get_transition('translation-x'))
            return;
        label.remove_transition('translation-x');
        label.remove_transition('opacity');
        if (label.translation_x === 0 && label.opacity === 255)
            return;
        if (smooth && this.mapped) {
            label.ease({
                translation_x: 0,
                opacity: 255,
                duration: MARQUEE_RESET_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            label.translation_x = 0;
            label.opacity = 255;
        }
    }

    _onDestroy() {
        this._coverCancellable?.cancel();
        this._coverCancellable = null;
        this._marqueeRange = -1;
        this._label.remove_all_transitions();
        this._label.disconnectObject(this);
        this._textClip.disconnectObject(this);
        this._stSettings.disconnectObject(this);
        this._stSettings = null;
        this._covers = null;
    }
});
