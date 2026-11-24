// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
import {
    dominantColor, ensureContrast, hslToRgb, mixColor, relativeLuminance, rgbToHsl,
} from '../lib/color.js';

// Imagem w×h (RGB, rowstride = w*3) a partir de uma função (x, y) → [r, g, b].
function image(w, h, fn, channels = 3) {
    const px = new Uint8Array(w * h * channels);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const c = fn(x, y);
            px.set(channels === 4 ? [c[0], c[1], c[2], c[3] ?? 255] : c.slice(0, 3), (y * w + x) * channels);
        }
    }
    return [px, w, h, w * channels, channels];
}

const hueOf = c => rgbToHsl(c).h * 360;

export function register({test, assert, assertEqual}) {
    test('rgbToHsl/hslToRgb: ida e volta', () => {
        for (const c of [{r: 255, g: 0, b: 0}, {r: 53, g: 132, b: 228}, {r: 10, g: 200, b: 90}, {r: 128, g: 128, b: 128}])
            assertEqual(hslToRgb(rgbToHsl(c)), c);
    });

    test('dominantColor: capa vermelha com fundo preto → vermelho', () => {
        const c = dominantColor(...image(24, 24, (x, y) =>
            (x > 6 && x < 18 && y > 6 && y < 18 ? [220, 30, 40] : [5, 5, 5])));
        assert(c, 'devia achar cor');
        const h = hueOf(c);
        assert(h < 15 || h > 345, `matiz ${h} não é vermelho`);
    });

    test('dominantColor: ignora cinzas, branco e preto mesmo em maioria', () => {
        // 80% cinza/branco/preto, 20% verde vivo → verde
        const c = dominantColor(...image(20, 20, (x, y) => {
            if (y < 4)
                return [40, 200, 80];
            return [[128, 128, 128], [250, 250, 250], [0, 0, 0]][(x + y) % 3];
        }));
        assert(c, 'devia achar cor');
        const h = hueOf(c);
        assert(h > 100 && h < 160, `matiz ${h} não é verde`);
    });

    test('dominantColor: imagem sem cor → null', () => {
        assertEqual(dominantColor(...image(24, 24, (x, y) => [(x * 10) % 256, (x * 10) % 256, (x * 10) % 256])), null);
        assertEqual(dominantColor(...image(24, 24, () => [0, 0, 0])), null);
    });

    test('dominantColor: RGBA ignora pixels transparentes', () => {
        const c = dominantColor(...image(10, 10, (x) =>
            (x < 5 ? [255, 0, 0, 0] : [30, 60, 230, 255]), 4));
        const h = hueOf(c);
        assert(h > 200 && h < 250, `matiz ${h} não é azul`);
    });

    test('dominantColor: resultado vibrante (saturação e brilho médios)', () => {
        const c = dominantColor(...image(8, 8, () => [70, 40, 30])); // marrom apagado
        assert(c, 'devia achar cor');
        const {s, l} = rgbToHsl(c);
        assert(s >= 0.54 && l >= 0.44 && l <= 0.66, `s=${s} l=${l}`);
    });

    test('ensureContrast: clareia no painel escuro e escurece no claro', () => {
        const navy = {r: 20, g: 30, b: 110};
        const light = ensureContrast(navy, true);
        assert(relativeLuminance(light) >= 0.279, 'pouco contraste no escuro');
        assert(Math.abs(hueOf(light) - hueOf(navy)) < 3, 'mudou a matiz');
        const yellow = {r: 250, g: 230, b: 60};
        assert(relativeLuminance(ensureContrast(yellow, false)) <= 0.301, 'pouco contraste no claro');
        // Já com contraste: não mexe
        assertEqual(ensureContrast(yellow, true), yellow);
    });

    test('mixColor', () => {
        assertEqual(mixColor({r: 0, g: 0, b: 0}, {r: 200, g: 100, b: 50}, 0.5), {r: 100, g: 50, b: 25});
    });
}
