// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Botão do painel: uma "pílula" com 3 barrinhas de equalizador desenhadas em Cairo.
// Dois modos (configuráveis): compacto (só as barrinhas) e expandido (capa +
// título/artista + barrinhas). O compacto pode expandir por um instante ao
// passar o mouse ou ao trocar de faixa. Em volta, um contorno opcional mostra o
// progresso da música (progressRing.js), na cor dominante da capa.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {isCancelled} from './coverArt.js';
import {PillDetails} from './pillDetails.js';
import {ProgressRing} from './progressRing.js';
import {PlayerCard} from './playerCard.js';

const BAR_COUNT = 3;
// Alturas (0–1) das barrinhas quando pausado.
const STATIC_LEVELS = [0.45, 0.85, 0.6];
// Limita a ~30 quadros/s: o painel não precisa de 144 Hz para 3 barrinhas.
const MIN_REPAINT_INTERVAL_US = 33000;
// Tempo para as barrinhas "acordarem"/"adormecerem" ao dar play/pause.
const RAMP_MS = 300;

// Expansão da pílula (ease-out, como pedido: ~250–300 ms).
const EXPAND_MS = 280;
const PAUSED_OPACITY = 140;   // capa e título apagados com a música pausada
// Espaço à esquerda: no compacto é igual ao padding direito (barrinhas
// centralizadas); com a capa, ela "abraça" a ponta arredondada da pílula.
const COMPACT_LEAD = 9;
const COVER_LEAD = 1;
// Nos primeiros px da expansão o espaço esquerdo encolhe junto: a largura
// total da pílula só cresce (sem "pulo" de 8 px no começo).
const LEAD_RAMP = 32;

// Contorno de progresso: amostra a posição a cada 500 ms (só tocando; entre
// amostras o anel extrapola sozinho) e relê a posição real no D-Bus a cada
// 6 amostras (~3 s), como o card — players nem sempre avisam um seek.
const PROGRESS_SAMPLE_MS = 500;
const PROGRESS_RESYNC_EVERY = 6;
const RING_THICKNESS = {thin: 2, medium: 3};

/**
 * Ícone de equalizador. A animação usa uma Clutter.Timeline presa ao próprio
 * ator: ela anda no ritmo do relógio de quadros do compositor e para sozinha
 * quando o ator não está visível — mais barato que um GLib.timeout.
 */
export const EqualizerIcon = GObject.registerClass({
    GTypeName: 'WavebarMusicEqualizerIcon',
}, class EqualizerIcon extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'wavebar-music-equalizer',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._playing = false;
        this._amplitude = 0; // 0 = barras estáticas, 1 = animação plena
        this._lastFrameUs = 0;
        this._lastRepaintUs = 0;

        this._timeline = new Clutter.Timeline({
            actor: this,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connectObject('new-frame', () => this._onNewFrame(), this);

        // Respeita "Animações" desligadas nas configurações de acessibilidade.
        this._stSettings = St.Settings.get();
        this._stSettings.connectObject('notify::enable-animations',
            () => this._sync(), this);

        this.connect('destroy', () => this._onDestroy());
    }

    get playing() {
        return this._playing;
    }

    set playing(playing) {
        if (this._playing === playing)
            return;
        this._playing = playing;
        this._sync();
    }

    _sync() {
        if (!this._stSettings.enable_animations) {
            this._timeline.stop();
            this._amplitude = 0;
            this.queue_repaint();
            return;
        }

        // Ao pausar, a timeline continua rodando até a amplitude chegar a 0
        // (transição suave); quem para é o _onNewFrame().
        if (this._playing && !this._timeline.is_playing()) {
            this._lastFrameUs = GLib.get_monotonic_time();
            this._timeline.start();
        }
    }

    _onNewFrame() {
        const now = GLib.get_monotonic_time();
        const step = (now - this._lastFrameUs) / 1000 / RAMP_MS;
        this._lastFrameUs = now;

        this._amplitude = this._playing
            ? Math.min(1, this._amplitude + step)
            : Math.max(0, this._amplitude - step);

        if (!this._playing && this._amplitude === 0) {
            this._timeline.stop();
            this.queue_repaint();
            return;
        }

        if (now - this._lastRepaintUs < MIN_REPAINT_INTERVAL_US)
            return;
        this._lastRepaintUs = now;
        this.queue_repaint();
    }

    // Duas senoides de frequências diferentes por barra: movimento "orgânico"
    // sem precisar de números aleatórios.
    _animatedLevel(index, seconds) {
        const a = Math.sin(seconds * (5.3 + index * 1.7) + index * 1.3);
        const b = Math.sin(seconds * (2.9 + index * 0.8) + index * 2.1);
        return 0.25 + 0.75 * Math.abs(a * 0.6 + b * 0.4);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            const color = this.get_theme_node().get_foreground_color();
            const seconds = GLib.get_monotonic_time() / 1e6;

            // Barras e espaços com a mesma largura: 3 barras + 2 espaços.
            const barWidth = width / (BAR_COUNT * 2 - 1);
            const radius = barWidth / 2;

            cr.setSourceColor(color);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineWidth(barWidth);

            for (let i = 0; i < BAR_COUNT; i++) {
                const level = STATIC_LEVELS[i] * (1 - this._amplitude) +
                    this._animatedLevel(i, seconds) * this._amplitude;
                const barHeight = Math.max(barWidth, level * height);
                const x = radius + i * barWidth * 2;

                // Com a ponta arredondada, a linha "cresce" radius em cada lado.
                cr.moveTo(x, (height - barHeight) / 2 + radius);
                cr.lineTo(x, (height + barHeight) / 2 - radius);
                cr.stroke();
            }
        } catch (e) {
            console.error('[Wavebar Music] Erro ao desenhar o equalizador:', e);
        } finally {
            cr.$dispose();
        }
    }

    _onDestroy() {
        this._timeline.stop();
        this._timeline.disconnectObject(this);
        this._stSettings.disconnectObject(this);
        this._timeline = null;
        this._stSettings = null;
    }
});

/**
 * Botão do painel. Herda de PanelMenu.Button, que já cria o menu (popup)
 * ancorado e trata clique/teclado com Clutter.ClickGesture (GNOME 51).
 */
export const WavebarMusicIndicator = GObject.registerClass({
    GTypeName: 'WavebarMusicIndicator',
}, class WavebarMusicIndicator extends PanelMenu.Button {
    _init(manager, services) {
        super._init(0.5, 'Wavebar Music', false);
        this.add_style_class_name('wavebar-music-button');
        this._manager = manager;
        this._settings = services.settings;

        // Cliques (GNOME 51 usa gestos do Clutter, não mais eventos):
        //  - DIREITO: abre o card. O PanelMenu.Button cria um ClickGesture que
        //    abre o menu com qualquer botão; restringimos ao botão direito.
        //  - ESQUERDO: pausa o que estiver tocando (qualquer player) ou retoma.
        // Enter/Espaço no ícone focado continuam abrindo o card (teclado).
        this._clickGesture?.set_required_button(Clutter.BUTTON_SECONDARY);
        this._playbackGesture = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_PRIMARY,
        });
        this._playbackGesture.connect('recognize', () => this._manager?.togglePlayback());
        this.add_action(this._playbackGesture);

        // Pílula: [espaço][detalhes (capa + texto)][barrinhas]. Os detalhes
        // ficam num contêiner que recorta o conteúdo; animar a LARGURA dele é
        // o que expande/encolhe a pílula. No compacto a largura é 0 (oculto).
        this._pill = new St.BoxLayout({
            style_class: 'wavebar-music-panel-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._lead = new St.Widget({width: COMPACT_LEAD});
        this._details = new PillDetails(services.covers);
        this._detailsClip = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
            width: 0,
            opacity: 0,
            visible: false,
        });
        this._detailsClip.add_child(this._details);
        this._equalizer = new EqualizerIcon();
        this._pill.add_child(this._lead);
        this._pill.add_child(this._detailsClip);
        this._pill.add_child(this._equalizer);

        // Pílula + contorno empilhados (BinLayout: o anel cobre a pílula e a
        // margem dela, onde cabe o brilho). O anel não recebe cliques.
        this._ring = new ProgressRing(this._pill);
        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._stack.add_child(this._pill);
        this._stack.add_child(this._ring);
        this.add_child(this._stack);

        this._coverColors = services.coverColors;
        this._progressTimerId = 0;
        this._progressTicks = 0;
        this._colorKey = undefined;  // capa cuja cor está aplicada (null = sem cor dinâmica)
        this._colorCancellable = null;

        this._playing = false;
        this._hasTrack = false;
        this._trackKey = null;
        this._peekId = 0;            // timer da expansão temporária (troca de faixa)
        this._targetWidth = -1;      // alvo da animação em curso (-1 = nenhum ainda)
        this._targetOpacity = -1;

        this._detailsClip.connectObject('notify::width', () => this._syncLead(), this);
        // style-changed: entrou no palco, mudou fonte/escala → medir de novo.
        // mapped: reapareceu (ex.: primeiro player abriu) → expande animando.
        // (Fora da tela o _updateExpansion() aplica sem animação.)
        this._pill.connectObject(
            'style-changed', () => this._updateExpansion(),
            'notify::mapped', () => this._updateExpansion(), this);
        this.connect('notify::hover', () => {
            if (this._settings.get_boolean('expand-on-hover'))
                this._updateExpansion();
        });

        // Configurações valem na hora (sem desativar/reativar a extensão).
        this._settings.connectObject('changed', () => this._applySettings(), this);
        this._applySettings();

        // O card mora dentro do menu (popup) que o PanelMenu.Button já criou.
        this.menu.actor.add_style_class_name('wavebar-music-menu');
        this.menu.box.add_style_class_name('wavebar-music-menu-content');
        this._card = new PlayerCard(manager, services);
        this.menu.box.add_child(this._card);
        this._card.connect('close-request', () => this.menu.close());
        this.menu.connectObject('open-state-changed',
            (_menu, open) => this._card.setOpen(open), this);

        // Aparência: tema e integração com o Blur my Shell.
        this._appearance = services.appearance;
        this._appearance.connectObject('changed', () => this._applyAppearance(), this);
        this._applyAppearance();

        // O BMS troca o raio dos cantos do contêiner (estilo inline); a capa
        // acompanha para os cantos ficarem concêntricos.
        this.menu.box.connectObject('style-changed', () => {
            const node = this.menu.box.get_theme_node();
            this._card.setContainerShape(
                node.get_border_radius(St.Corner.TOPLEFT),
                node.get_padding(St.Side.LEFT));
        }, this);

        this._manager.connectObject(
            'changed', () => this._sync(),
            'seeked', () => this._syncProgress(), this);
        this._sync();
    }

    _applyAppearance() {
        const box = this.menu.box;
        const {variant, blurActive, bmsActive} = this._appearance;
        const toggle = (name, on) => (on ? box.add_style_class_name(name)
            : box.remove_style_class_name(name));

        toggle('wavebar-music-theme-dark', variant === 'dark');
        toggle('wavebar-music-theme-light', variant === 'light');
        // Fundo próprio, a menos que o BMS esteja cuidando dele (tema automático).
        toggle('wavebar-music-bg-dark', !blurActive && variant === 'dark');
        toggle('wavebar-music-bg-light', !blurActive && variant === 'light');
        // Com desfoque por trás, o nosso fundo fica mais translúcido.
        toggle('wavebar-music-over-blur', bmsActive);
    }

    _applySettings() {
        const s = this._settings;
        this._compact = s.get_string('panel-mode') !== 'expanded';
        this._details.showCover = s.get_boolean('show-cover');
        this._details.scrollEnabled = s.get_boolean('scroll-long-title');
        // Só baixa a capa se a pílula tiver alguma chance de expandir.
        this._details.active = !this._compact || s.get_boolean('expand-on-hover') ||
            s.get_boolean('expand-on-track-change');
        if (!this._compact || !s.get_boolean('expand-on-track-change'))
            this._stopPeek();

        // Contorno: a margem da pílula (espaço do brilho) só existe com ele ligado.
        if (s.get_boolean('show-progress-ring'))
            this._pill.add_style_class_name('wavebar-music-with-ring');
        else
            this._pill.remove_style_class_name('wavebar-music-with-ring');
        this._ring.setThickness(RING_THICKNESS[s.get_string('progress-ring-thickness')] ?? 2);
        this._syncProgress();

        this._updateExpansion();
    }

    // Só aparece com pelo menos um player ativo; anima só se estiver tocando.
    _sync() {
        this.visible = this._manager.players.length > 0;

        const player = this._manager.current;
        const md = player?.metadata;
        // Sem faixa (nenhum player, ou player sem título) → compacto.
        this._hasTrack = this.visible && !!md?.title;
        if (this._hasTrack)
            this._details.setTrack(md);

        // Troca de faixa (ou de player) → expansão temporária, se ligada.
        // Só com música tocando: ao ativar a extensão com tudo pausado, nada pisca.
        const key = this._hasTrack ? player.trackKey : null;
        if (key !== this._trackKey) {
            this._trackKey = key;
            if (key && player.status === 'Playing')
                this._peek();
        }
        if (!this._hasTrack)
            this._stopPeek();

        this.setPlaying(this._manager.anyPlaying);
        this._syncProgress();
    }

    setPlaying(playing) {
        this._playing = playing;
        this._equalizer.playing = playing;
        this._details.playing = playing;
        if (playing)
            this._pill.remove_style_class_name('wavebar-music-paused');
        else
            this._pill.add_style_class_name('wavebar-music-paused');
        this._updateExpansion();
    }

    // ---------- Contorno de progresso ----------

    /**
     * Passa a posição atual ao anel e liga/desliga o timer de amostragem.
     * Chamada a cada mudança do player, seek, configuração e pelo timer.
     */
    _syncProgress() {
        if (!this._manager)
            return; // destruído (resposta do D-Bus chegando depois)
        const player = this._manager.current;
        const length = player?.metadata.length ?? 0;
        // Sem duração (rádio/ao vivo) ou sem Position: esconde, em vez de
        // mostrar um valor errado.
        const shown = this._settings.get_boolean('show-progress-ring') && this.visible &&
            this._hasTrack && length > 0 && player.positionSupported;
        this._ring.setShown(shown);
        if (!shown) {
            this._stopProgressTimer();
            return;
        }

        const playing = player.status === 'Playing';
        const rate = playing ? (player.rate || 1) / length : 0;
        this._ring.setProgress(player.position / length, rate);
        this._syncCoverColor(player.metadata.artUrl);

        if (!playing)
            this._stopProgressTimer();
        else if (!this._progressTimerId)
            this._startProgressTimer();
    }

    _startProgressTimer() {
        this._progressTicks = 0;
        this._progressTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_SAMPLE_MS, () => {
            const player = this._manager.current;
            if (++this._progressTicks % PROGRESS_RESYNC_EVERY === 0 && player)
                player.refreshPosition().then(() => this._syncProgress()).catch(() => {});
            else
                this._syncProgress();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopProgressTimer() {
        if (!this._progressTimerId)
            return;
        GLib.source_remove(this._progressTimerId);
        this._progressTimerId = 0;
    }

    // Cor dominante da capa, uma vez por capa e assíncrona. Até ela chegar o
    // anel mantém a cor anterior, e então faz a transição suave.
    _syncCoverColor(artUrl) {
        const dynamic = this._settings.get_boolean('progress-ring-dynamic-color');
        const key = dynamic ? artUrl || '' : null;
        if (key === this._colorKey)
            return;
        this._colorKey = key;
        this._colorCancellable?.cancel();
        this._colorCancellable = null;

        if (!key) {
            this._ring.setColor(null); // cor de destaque
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._colorCancellable = cancellable;
        this._coverColors.colorFor(artUrl, cancellable).then(color => {
            if (!cancellable.is_cancelled())
                this._ring.setColor(color); // null (sem cor/erro) → destaque
        }).catch(e => {
            if (!isCancelled(e))
                logError(e, '[Wavebar Music] cor da capa');
        });
    }

    // ---------- Expansão ----------

    _shouldExpand() {
        if (!this._hasTrack)
            return false;
        if (!this._compact)
            return true;
        return this._peekId !== 0 ||
            (this.hover && this._settings.get_boolean('expand-on-hover'));
    }

    _peek() {
        if (!this._compact || !this._settings.get_boolean('expand-on-track-change'))
            return;
        // Troca rápida de faixas: reinicia a contagem (fica aberta até
        // N segundos depois da ÚLTIMA troca).
        if (this._peekId)
            GLib.source_remove(this._peekId);
        const seconds = Math.min(10, Math.max(2, this._settings.get_int('track-change-duration')));
        this._peekId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => {
            this._peekId = 0;
            this._updateExpansion();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopPeek() {
        if (!this._peekId)
            return;
        GLib.source_remove(this._peekId);
        this._peekId = 0;
    }

    _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    _expandedLead() {
        return this._settings.get_boolean('show-cover') ? COVER_LEAD : COMPACT_LEAD;
    }

    /**
     * Leva a pílula ao estado certo (compacta ou expandida), animando a
     * largura e a opacidade dos detalhes. Chamada sempre que algo muda: é
     * barata quando o alvo não muda.
     */
    _updateExpansion(animate = true) {
        // Fora do palco ainda não há tema para medir; o "style-changed" de
        // quando ele entrar chama de novo.
        if (!this._pill.get_stage())
            return;
        this._syncLead(); // a escala da tela pode ter mudado

        const expand = this._shouldExpand();
        let width = 0;
        if (expand) {
            // Largura natural do conteúdo, limitada pela largura máxima da
            // pílula inteira (descontando barrinhas, padding e espaço à esquerda).
            const scale = this._scale();
            const [, natural] = this._details.get_preferred_width(-1);
            const [, eqWidth] = this._equalizer.get_preferred_width(-1);
            const rightPad = this._pill.get_theme_node().get_padding(St.Side.RIGHT);
            const room = this._settings.get_int('expanded-max-width') * scale -
                rightPad - eqWidth - this._expandedLead() * scale;
            width = Math.round(Math.max(0, Math.min(natural, room)));
        }
        const opacity = !expand ? 0 : this._playing ? 255 : PAUSED_OPACITY;
        if (width === this._targetWidth && opacity === this._targetOpacity)
            return;
        this._targetWidth = width;
        this._targetOpacity = opacity;

        const clip = this._detailsClip;
        if (width > 0)
            clip.show();
        // Expandida: fundo neutro e cor de destaque só nas barrinhas e no anel
        // da capa (stylesheet.css). A troca do fundo anima pelo CSS do St.
        if (width > 0)
            this._pill.add_style_class_name('wavebar-music-expanded');
        else
            this._pill.remove_style_class_name('wavebar-music-expanded');
        // Marquee congelado enquanto a área visível muda de tamanho.
        this._details.frozen = true;
        const done = () => {
            if (this._targetWidth === 0)
                clip.hide(); // largura já é 0: esconder não mexe no layout
            this._details.frozen = false;
        };

        if (animate && this._pill.mapped) {
            // ease() substitui uma animação anterior pela metade sem saltos:
            // parte do valor atual. O onComplete da anterior não é chamado.
            clip.ease({
                width,
                opacity,
                duration: EXPAND_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: done,
            });
        } else {
            clip.remove_all_transitions();
            clip.set({width, opacity});
            done();
        }
    }

    /**
     * Pula a animação de expansão em curso e aplica o estado final na hora.
     * Usado quando o indicador acaba de ser recriado: quem anima é o
     * contêiner no painel (extension.js), que precisa medir a largura FINAL.
     */
    finishExpansion() {
        this._targetWidth = -1; // força reaplicar mesmo com o alvo igual
        this._updateExpansion(false);
    }

    // O espaço à esquerda acompanha a largura dos detalhes (chamado a cada
    // quadro da animação): vai de COMPACT_LEAD a COVER_LEAD nos primeiros
    // LEAD_RAMP px. Como LEAD_RAMP > COMPACT_LEAD - COVER_LEAD, a pílula
    // nunca encolhe enquanto expande.
    //
    // O espaço também absorve a parte fracionária da largura animada dos
    // detalhes (o ease produz valores como 106,7 px): espaço + detalhes dá
    // sempre um número inteiro. Sem isso, o PanelMenu.ButtonBox compara
    // "natural + padding ≤ espaço recebido", o painel arredonda o espaço para
    // baixo e, em quadros alternados, o botão troca o padding normal pelo
    // mínimo — a pílula "tremia" 5 px para os lados durante a expansão.
    _syncLead() {
        const scale = this._scale();
        const clip = this._detailsClip.width;
        const progress = Math.min(1, clip / (LEAD_RAMP * scale));
        const lead = COMPACT_LEAD + (this._expandedLead() - COMPACT_LEAD) * progress;
        this._lead.width = Math.max(0, Math.round(lead * scale + clip) - clip);
    }

    _onDestroy() {
        // Desconecta do menu ANTES de tudo: ao ser destruído (super._onDestroy)
        // o menu ainda se fecha e emite "open-state-changed" — e o card já
        // não existiria mais (erro "this._card is null" ao desativar com o
        // card aberto).
        this.menu.disconnectObject(this);
        this.menu.box.disconnectObject(this);
        this._stopPeek();
        this._stopProgressTimer();
        this._colorCancellable?.cancel();
        this._colorCancellable = null;
        this._settings.disconnectObject(this);
        this._settings = null;
        this._pill.disconnectObject(this);
        this._detailsClip.remove_all_transitions();
        this._detailsClip.disconnectObject(this);
        this._appearance.disconnectObject(this);
        this._appearance = null;
        this._manager.disconnectObject(this);
        this._manager = null;
        super._onDestroy(); // destrói o menu e, junto, o card
        this._card = null;
    }
});
