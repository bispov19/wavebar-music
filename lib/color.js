// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Cores: escolha da cor dominante de uma capa e ajuste de contraste.
// Funções puras (sem St/Clutter/Shell): testáveis com `gjs -m tests/run.js`.
// Cores são objetos {r, g, b} com componentes de 0 a 255.

const HUE_BUCKETS = 24;          // fatias de 15° no círculo de cores
const MIN_VALUE = 0.2;           // mais escuro que isso: ignorado
const MAX_LIGHTNESS = 0.9;       // mais claro que isso (quase branco): ignorado
const MIN_SATURATION = 0.25;     // menos saturado (cinza): ignorado
const MIN_SHARE = 0.03;          // pixels "coloridos" precisam ser ≥ 3% da imagem

function clamp(x, min, max) {
    return Math.min(max, Math.max(min, x));
}

/** {r,g,b} (0–255) → {h, s, l} (0–1). */
export function rgbToHsl({r, g, b}) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return {h: 0, s: 0, l};
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return {h: h / 6, s, l};
}

/** {h, s, l} (0–1) → {r,g,b} (0–255, inteiros). */
export function hslToRgb({h, s, l}) {
    if (s === 0) {
        const v = Math.round(l * 255);
        return {r: v, g: v, b: v};
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = t => {
        t = (t % 1 + 1) % 1;
        if (t < 1 / 6)
            return p + (q - p) * 6 * t;
        if (t < 1 / 2)
            return q;
        if (t < 2 / 3)
            return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return {
        r: Math.round(channel(h + 1 / 3) * 255),
        g: Math.round(channel(h) * 255),
        b: Math.round(channel(h - 1 / 3) * 255),
    };
}

/**
 * Cor vibrante representativa de uma imagem pequena (ex.: capa reduzida a
 * 24×24). Ignora pixels muito escuros, muito claros, pouco saturados ou
 * transparentes; agrupa o resto por matiz (pesando saturação × brilho) e
 * devolve a média da faixa de matiz mais forte. null se a imagem não tiver
 * cor suficiente (capa em preto e branco, por exemplo).
 *
 * @param {Uint8Array} pixels - linhas de `rowstride` bytes, `channels` por pixel (RGB ou RGBA)
 */
export function dominantColor(pixels, width, height, rowstride, channels) {
    const weight = new Float64Array(HUE_BUCKETS);
    const sums = Array.from({length: HUE_BUCKETS}, () => [0, 0, 0]);
    let counted = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * rowstride + x * channels;
            if (channels === 4 && pixels[i + 3] < 128)
                continue;
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
            const saturation = max > 0 ? (max - min) / max : 0;   // HSV
            if (max < MIN_VALUE || (max + min) / 2 > MAX_LIGHTNESS || saturation < MIN_SATURATION)
                continue;

            const {h} = rgbToHsl({r, g, b});
            const bucket = Math.floor(h * HUE_BUCKETS) % HUE_BUCKETS;
            // Peso: cores vivas e claras "valem" mais que as apagadas.
            const w = saturation * saturation * max;
            weight[bucket] += w;
            sums[bucket][0] += r * w;
            sums[bucket][1] += g * w;
            sums[bucket][2] += b * w;
            counted++;
        }
    }
    if (counted < Math.max(1, width * height * MIN_SHARE))
        return null;

    // Matiz mais forte, somando as faixas vizinhas (uma cor real costuma
    // cair na fronteira entre duas fatias).
    let best = 0, bestWeight = -1;
    for (let k = 0; k < HUE_BUCKETS; k++) {
        const around = weight[(k + HUE_BUCKETS - 1) % HUE_BUCKETS] + weight[k] +
            weight[(k + 1) % HUE_BUCKETS];
        if (around > bestWeight) {
            bestWeight = around;
            best = k;
        }
    }
    let total = 0;
    const rgb = [0, 0, 0];
    for (const k of [best - 1, best, best + 1]) {
        const j = (k + HUE_BUCKETS) % HUE_BUCKETS;
        total += weight[j];
        for (let c = 0; c < 3; c++)
            rgb[c] += sums[j][c];
    }
    const color = {r: rgb[0] / total, g: rgb[1] / total, b: rgb[2] / total};

    // Garante que é "vibrante": satura um pouco e evita os extremos de brilho.
    const hsl = rgbToHsl(color);
    return hslToRgb({h: hsl.h, s: Math.max(hsl.s, 0.55), l: clamp(hsl.l, 0.45, 0.65)});
}

/** Luminância relativa (WCAG), 0 (preto) a 1 (branco). */
export function relativeLuminance({r, g, b}) {
    const lin = c => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Mistura linear: t = 0 → a, t = 1 → b. */
export function mixColor(a, b, t) {
    return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
    };
}

/**
 * Garante contraste mínimo contra o fundo: num painel escuro, clareia a cor
 * (misturando com branco) até a luminância chegar a `minLight`; num claro,
 * escurece até `maxDark`. Mantém a matiz.
 */
export function ensureContrast(color, darkBackground, {minLight = 0.28, maxDark = 0.3} = {}) {
    const toward = darkBackground ? {r: 255, g: 255, b: 255} : {r: 0, g: 0, b: 0};
    const ok = c => (darkBackground ? relativeLuminance(c) >= minLight
        : relativeLuminance(c) <= maxDark);
    if (ok(color))
        return color;
    // Busca binária pela menor mistura que atinge o contraste.
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (ok(mixColor(color, toward, mid)))
            hi = mid;
        else
            lo = mid;
    }
    return mixColor(color, toward, hi);
}
