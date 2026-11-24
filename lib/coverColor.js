// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Cor dominante da capa (para o contorno de progresso da pílula).
//
// Uma vez por capa e sem travar o Shell: o arquivo vem do mesmo
// CoverArtLoader (cache em disco) e o GdkPixbuf decodifica a imagem já
// reduzida para 24×24 numa thread própria (*_async). O cálculo da cor em si
// é a função pura dominantColor() de color.js. Resultados ficam em memória.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

import {LruMap} from './cache.js';
import {dominantColor} from './color.js';
import {isCancelled} from './coverArt.js';

Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');

const SAMPLE_SIZE = 24;
const MAX_ENTRIES = 100;

export class CoverColorExtractor {
    constructor(covers) {
        this._covers = covers;
        this._memory = new LruMap(MAX_ENTRIES); // artUrl → {r,g,b} ou null
    }

    /**
     * Cor dominante da capa em `url` (mpris:artUrl), ou null sem capa, sem
     * cor (capa P&B) ou em caso de erro. Lança só se for cancelada.
     */
    async colorFor(url, cancellable) {
        if (!url)
            return null;
        if (this._memory.has(url))
            return this._memory.get(url);

        let color = null;
        try {
            const path = await this._covers.load(url, cancellable);
            if (path) {
                const stream = await Gio.File.new_for_path(path).read_async(0, cancellable);
                try {
                    const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                        stream, SAMPLE_SIZE, SAMPLE_SIZE, false, cancellable);
                    color = dominantColor(pixbuf.get_pixels(), pixbuf.get_width(),
                        pixbuf.get_height(), pixbuf.get_rowstride(), pixbuf.get_n_channels());
                } finally {
                    stream.close_async(0, null, null);
                }
            }
        } catch (e) {
            if (isCancelled(e))
                throw e;
            console.log(`[Wavebar Music] Não consegui tirar a cor da capa: ${e.message}`);
            return null; // falha pode ser passageira: não memoriza
        }
        this._memory.set(url, color);
        return color;
    }

    destroy() {
        this._memory.clear();
        this._covers = null;
    }
}
