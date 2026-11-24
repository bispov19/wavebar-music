// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Contorno de progresso em volta da pílula do painel (Cairo).
//
// O traço começa no topo, no centro da pílula, e dá a volta no sentido
// horário até fechar no mesmo ponto quando a música termina. Por baixo, um
// trilho translúcido mostra o caminho inteiro; em volta, um brilho discreto
// na mesma cor.
//
// Movimento contínuo sem desperdício:
//   - quem chama (panelIndicator.js) informa a posição de tempos em tempos
//     (fração + velocidade); entre uma amostra e outra o traço é
//     EXTRAPOLADO a cada quadro;
//   - saltos (seek, troca de faixa, ressincronia) viram um ease-out-cubic a
//     partir de onde o traço está, sem pulo;
//   - só redesenha quando o traço andou ≥ MIN_STEP_PX (numa música de 3 min,
//     ~12 redesenhos/s em vez de 60), e o relógio de quadros PARA quando não
//     há nada se mexendo (pausado, sem animação de cor/espessura).

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {ensureContrast, mixColor, relativeLuminance} from './color.js';

const PROGRESS_EASE_US = 280000;   // seek / troca de faixa
const COLOR_EASE_US = 650000;      // troca de cor entre faixas
const WIDTH_EASE_US = 220000;      // troca de espessura
const FADE_MS = 220;               // aparecer / sumir
const MIN_STEP_PX = 0.25;          // menor avanço que vale um redesenho
const MIN_JUMP_PX = 1;             // diferença menor que isso é corrigida sem animação
const TRACK_ALPHA = 0.22;
// Brilho: três traços largos e bem translúcidos sobre a borda da pílula
// ([largura extra em px, alfa]).
const GLOW_LAYERS = [[6, 0.05], [4, 0.08], [2.4, 0.12]];

const easeOutCubic = t => 1 - (1 - t) ** 3;
const clamp01 = x => Math.min(1, Math.max(0, x));

function colorFromCogl(c) {
    return {r: c.red, g: c.green, b: c.blue};
}

export const ProgressRing = GObject.registerClass({
    GTypeName: 'WavebarMusicProgressRing',
}, class ProgressRing extends St.DrawingArea {
    /** @param {Clutter.Actor} pill - ator cujo contorno é desenhado (irmão no mesmo contêiner) */
    _init(pill) {
        super._init({
            style_class: 'wavebar-music-panel-pill-ring',
            reactive: false,
            x_expand: true,
            y_expand: true,
            opacity: 0,
            visible: false,
        });
        this._pill = pill;

        // Progresso: base + velocidade (fração por µs) a partir de baseTime.
        this._base = 0;
        this._baseTime = GLib.get_monotonic_time();
        this._rate = 0;
        this._ease = null;          // {from, start}: transição de salto
        this._hasProgress = false;  // já recebeu alguma posição?
        this._drawn = -1;           // fração do último desenho

        // Cor: o que foi pedido (null = cor de destaque) e o que está na tela.
        this._requested = null;
        this._target = null;        // pedido + contraste garantido
        this._shown = null;
        this._colorEase = null;     // {from, start}

        this._lineWidth = 2;
        this._widthTarget = 2;
        this._widthEase = null;     // {from, start}

        this._shownWanted = false;

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connectObject('new-frame', () => this._onFrame(), this);
        // A cor de destaque e a do painel vêm do tema: recalcula quando mudam.
        this.connectObject('style-changed', () => this._updateTargetColor(false), this);
        this.connect('destroy', () => this._onDestroy());
    }

    // ---------- API ----------

    /** Mostra/esconde com um fade (sem duração/posição conhecida: escondido). */
    setShown(shown) {
        if (shown === this._shownWanted)
            return;
        this._shownWanted = shown;
        if (shown) {
            this.show();
            this.ease({opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            this._kick();
        } else {
            this.ease({
                opacity: 0,
                duration: FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    this.hide();
                    this._timeline.stop();
                    // Ao reaparecer (outra faixa, outro player), começa sem animar.
                    this._hasProgress = false;
                },
            });
        }
    }

    /**
     * @param {number} fraction - 0–1, posição agora
     * @param {number} rate - fração por µs (0 se pausado)
     */
    setProgress(fraction, rate) {
        const now = GLib.get_monotonic_time();
        fraction = clamp01(fraction);
        const shown = this._displayed(now);

        // Salto visível (seek, nova faixa, ressincronia): anima a partir de
        // onde o traço está. Diferença minúscula: corrige direto.
        const jump = Math.abs(fraction - shown) * this._perimeter();
        if (this._hasProgress && jump >= MIN_JUMP_PX && this._canAnimate())
            this._ease = {from: shown, start: now};

        this._base = fraction;
        this._baseTime = now;
        this._rate = rate;
        this._hasProgress = true;
        this._kick();
    }

    /** Cor do traço; null = cor de destaque do sistema. Troca com transição. */
    setColor(color) {
        this._requested = color;
        this._updateTargetColor(true);
    }

    /** Espessura em px (lógicos). */
    setThickness(px) {
        if (px === this._widthTarget)
            return;
        const now = GLib.get_monotonic_time();
        this._widthEase = this._canAnimate() ? {from: this._currentWidth(now), start: now} : null;
        this._widthTarget = px;
        this._kick();
    }

    // ---------- estado ao longo do tempo ----------

    _canAnimate() {
        return this.mapped && St.Settings.get().enable_animations;
    }

    _displayed(now) {
        const target = clamp01(this._base + this._rate * (now - this._baseTime));
        if (!this._ease)
            return target;
        const t = (now - this._ease.start) / PROGRESS_EASE_US;
        if (t >= 1) {
            this._ease = null;
            return target;
        }
        // Persegue o alvo EM MOVIMENTO: termina exatamente na posição atual.
        return this._ease.from + (target - this._ease.from) * easeOutCubic(t);
    }

    _currentColor(now) {
        if (!this._colorEase)
            return this._target;
        const t = (now - this._colorEase.start) / COLOR_EASE_US;
        if (t >= 1) {
            this._colorEase = null;
            return this._target;
        }
        return mixColor(this._colorEase.from, this._target, easeOutCubic(t));
    }

    _currentWidth(now) {
        if (!this._widthEase)
            return this._widthTarget;
        const t = (now - this._widthEase.start) / WIDTH_EASE_US;
        if (t >= 1) {
            this._widthEase = null;
            return this._widthTarget;
        }
        return this._widthEase.from + (this._widthTarget - this._widthEase.from) * easeOutCubic(t);
    }

    // Cor final = pedida (ou destaque), com contraste mínimo contra o painel.
    _updateTargetColor(animate) {
        if (!this.get_stage())
            return; // sem tema ainda; o style-changed ao entrar no palco chama de novo
        const accent = colorFromCogl(this.get_theme_node().get_foreground_color());
        // Texto do painel claro → painel escuro (e vice-versa).
        const panelText = this.get_parent()?.get_theme_node().get_foreground_color();
        const darkPanel = !panelText || relativeLuminance(colorFromCogl(panelText)) > 0.4;
        const target = ensureContrast(this._requested ?? accent, darkPanel);

        const now = GLib.get_monotonic_time();
        if (this._target && animate && this._canAnimate())
            this._colorEase = {from: this._currentColor(now), start: now};
        else
            this._colorEase = null;
        this._target = target;
        this._kick();
    }

    // Algo mudou: redesenha e liga o relógio de quadros se houver movimento.
    _kick() {
        this.queue_repaint();
        if (!this._shownWanted || !this._canAnimate())
            return;
        const moving = this._rate > 0 || this._ease || this._colorEase || this._widthEase;
        if (moving && !this._timeline.is_playing())
            this._timeline.start();
    }

    _onFrame() {
        const now = GLib.get_monotonic_time();
        const animating = this._colorEase || this._widthEase;
        const fraction = this._displayed(now);
        const stepPx = Math.abs(fraction - this._drawn) * this._perimeter();

        if (animating || stepPx >= MIN_STEP_PX)
            this.queue_repaint();
        // Pausado e sem transições: nada mais se mexe → para o relógio.
        if (this._rate === 0 && !this._ease && !this._colorEase && !this._widthEase &&
            stepPx < MIN_STEP_PX)
            this._timeline.stop();
    }

    // ---------- desenho ----------

    // Retângulo da pílula em coordenadas deste ator (os dois são filhos do
    // mesmo contêiner; a pílula tem margem para sobrar espaço ao brilho).
    _pillBox() {
        const box = this._pill.allocation, own = this.allocation;
        return {
            x: box.x1 - own.x1,
            y: box.y1 - own.y1,
            w: box.x2 - box.x1,
            h: box.y2 - box.y1,
        };
    }

    _perimeter() {
        const {w, h} = this._pillBox();
        const lw = this._lineWidth;
        const r = Math.max(0, h - lw) / 2;
        return 2 * Math.max(0, w - lw - 2 * r) + 2 * Math.PI * r;
    }

    /**
     * Traça `fraction` do contorno de um retângulo de cantos totalmente
     * arredondados, começando no topo/centro, no sentido horário.
     * Segmentos: meia reta de cima → semicírculo direito → reta de baixo →
     * semicírculo esquerdo → meia reta de cima (de volta ao início).
     */
    _tracePath(cr, x, y, w, h, fraction) {
        const r = h / 2;
        const straight = Math.max(0, w - 2 * r);
        const total = 2 * straight + 2 * Math.PI * r;
        let left = fraction * total;
        const cx = x + w / 2;
        const right = x + w - r, leftC = x + r, cy = y + r;

        cr.moveTo(cx, y);
        const line = (len, x2, y2, fromX) => {
            const d = Math.min(left, len);
            if (d <= 0)
                return;
            cr.lineTo(fromX + (x2 - fromX) * (len > 0 ? d / len : 1), y2);
            left -= d;
        };
        const arc = (cxArc, start) => {
            const len = Math.PI * r;
            const d = Math.min(left, len);
            if (d <= 0)
                return;
            cr.arc(cxArc, cy, r, start, start + d / r);
            left -= d;
        };
        line(straight / 2, right, y, cx);
        arc(right, -Math.PI / 2);
        line(straight, leftC, y + h, right);
        arc(leftC, Math.PI / 2);
        line(straight / 2, cx, y, leftC);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const now = GLib.get_monotonic_time();
            const color = this._currentColor(now);
            if (!color)
                return;
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const lw = this._currentWidth(now) * scale;
            this._lineWidth = lw;
            const fraction = this._displayed(now);
            this._drawn = fraction;

            const {x, y, w, h} = this._pillBox();
            if (w <= 0 || h <= 0)
                return;
            const [r, g, b] = [color.r / 255, color.g / 255, color.b / 255];

            // Brilho sobre a borda da pílula (metade para fora, na margem).
            for (const [extra, alpha] of GLOW_LAYERS) {
                cr.setSourceRGBA(r, g, b, alpha);
                cr.setLineWidth(extra * scale);
                cr.newPath();
                this._tracePath(cr, x, y, w, h, 1);
                cr.closePath();
                cr.stroke();
            }

            // Trilho e traço: por dentro da borda, para não sair da pílula.
            const ix = x + lw / 2, iy = y + lw / 2, iw = w - lw, ih = h - lw;
            cr.setLineWidth(lw);
            cr.setSourceRGBA(r, g, b, TRACK_ALPHA);
            cr.newPath();
            this._tracePath(cr, ix, iy, iw, ih, 1);
            cr.closePath();
            cr.stroke();

            if (fraction * this._perimeter() >= 0.5) {
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setSourceRGBA(r, g, b, 1);
                cr.newPath();
                this._tracePath(cr, ix, iy, iw, ih, fraction);
                if (fraction >= 0.9995)
                    cr.closePath();
                cr.stroke();
            }
        } catch (e) {
            console.error('[Wavebar Music] Erro ao desenhar o contorno de progresso:', e);
        } finally {
            cr.$dispose();
        }
    }

    _onDestroy() {
        this._timeline.stop();
        this._timeline.disconnectObject(this);
        this._timeline = null;
        this._pill = null;
    }
});
