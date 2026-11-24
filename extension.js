// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
// Wavebar Music — controle de mídia universal (MPRIS) para o painel do GNOME Shell.
//
// Este arquivo só monta e desmonta as peças. Toda a lógica vive em lib/:
//   mpris.js          → descobre players no D-Bus e lê metadados
//   panelIndicator.js → botão do painel (pílula compacta ou expandida)
//   pillDetails.js    → capa + título com rolagem (marquee) da pílula expandida
//   playerCard.js     → card vertical aberto pelo botão
//   coverArt.js       → capas (file://, data:, http) com cache em disco
//   progressRing.js   → contorno de progresso em volta da pílula
//   coverColor.js / color.js → cor dominante da capa (para o contorno)
//   lyrics.js / lrc.js → letras do LRCLIB (sincronizadas ou não)
//   appearance.js     → tema claro/escuro e integração com o Blur my Shell

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Appearance} from './lib/appearance.js';
import {lookupPlayerApp} from './lib/appLookup.js';
import {CoverArtLoader} from './lib/coverArt.js';
import {CoverColorExtractor} from './lib/coverColor.js';
import {LyricsClient} from './lib/lyrics.js';
import {MprisManager} from './lib/mpris.js';
import {WavebarMusicIndicator} from './lib/panelIndicator.js';

// User-Agent genérico: identifica o app sem expor dados do usuário.
const USER_AGENT = 'WavebarMusic/0.5 (GNOME Shell extension)';
// Transição ao mostrar/ocultar o indicador no painel.
const INDICATOR_FADE_MS = 250;

export default class WavebarMusicExtension extends Extension {
    enable() {
        // Nada é criado no construtor: as regras do extensions.gnome.org
        // exigem que tudo nasça no enable() e morra no disable().
        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'wavebar-music']);

        // Uma única sessão HTTP para capas e letras (reaproveita conexões).
        this._session = new Soup.Session({user_agent: USER_AGENT, timeout: 15});
        this._settings = this.getSettings();
        this._services = {
            settings: this._settings,
            covers: new CoverArtLoader(this._session, cacheDir),
            lyrics: new LyricsClient(this._session, cacheDir),
            appearance: new Appearance(this._settings),
        };
        this._services.coverColors = new CoverColorExtractor(this._services.covers);

        this._manager = new MprisManager(lookupPlayerApp);
        this._indicator = null;
        // "Mostrar indicador no painel superior": desligado, o indicador é
        // DESTRUÍDO (nada de ator oculto, timers ou animações à toa) e
        // recriado quando a opção volta. Ao ativar a extensão não há transição.
        this._settings.connectObject('changed::show-panel-indicator',
            () => this._syncIndicator(true), this);
        this._syncIndicator(false);
        this._manager.start();
    }

    _syncIndicator(animate) {
        if (this._settings.get_boolean('show-panel-indicator'))
            this._showIndicator(animate);
        else
            this._hideIndicator(animate);
    }

    _showIndicator(animate) {
        if (!this._indicator) {
            this._indicator = new WavebarMusicIndicator(this._manager, this._services);
            // Mesmo lugar de sempre: o padrão do addToStatusArea (direita, posição 0).
            Main.panel.addToStatusArea(this.uuid, this._indicator);
            if (!animate)
                return;
            this._indicator.container.set({opacity: 0, width: 0});
            // A pílula expandida já nasce com a largura final (recortada pela
            // largura 0 do contêiner); senão mediríamos a compacta e haveria
            // um salto ao soltar a largura no fim.
            this._indicator.finishExpansion();
        }
        // Mostrar no meio de um "ocultar" (alternância rápida): o mesmo
        // indicador volta de onde parou, sem recriar.
        this._hidingIndicator = false;
        const container = this._indicator.container;
        // Largura natural do conteúdo (o contêiner está com largura fixa).
        // Sem player o indicador fica oculto e a largura natural é 0.
        const [, width] = this._indicator.visible
            ? this._indicator.get_preferred_width(-1) : [0, 0];
        container.ease({
            width,
            opacity: 255,
            duration: animate ? INDICATOR_FADE_MS : 0,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            // Solta a largura fixa: a pílula volta a crescer/encolher sozinha.
            onComplete: () => container.set_width(-1),
        });
    }

    _hideIndicator(animate) {
        if (!this._indicator || this._hidingIndicator)
            return;
        const indicator = this._indicator;
        const container = indicator.container;
        this._hidingIndicator = true;
        // Fecha o card antes de sumir com o botão que o ancora.
        indicator.menu.close();

        const destroy = () => {
            // Só destrói se ninguém pediu "mostrar" no meio da animação.
            if (!this._hidingIndicator || this._indicator !== indicator)
                return;
            this._hidingIndicator = false;
            this._destroyIndicator();
        };
        if (!animate || !container.mapped) {
            destroy();
            return;
        }
        // Fixa a largura atual e anima até 0: os vizinhos no painel deslizam
        // para o lugar, sem espaço vazio no fim.
        container.width = container.width;
        container.ease({
            width: 0,
            opacity: 0,
            duration: INDICATOR_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: destroy,
        });
    }

    _destroyIndicator() {
        // destroy() no indicador também destrói o menu, o card e cancela as
        // requisições do card; o painel tira a entrada de statusArea e o
        // contêiner. Transições pendentes do contêiner morrem junto (sem onComplete).
        this._indicator?.container.remove_all_transitions();
        this._indicator?.destroy();
        this._indicator = null;
        this._hidingIndicator = false;
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._destroyIndicator();

        // Depois do indicador: ele desconecta seus sinais do manager.
        this._manager?.destroy();
        this._manager = null;

        this._services?.coverColors.destroy();
        this._services?.covers.destroy();
        this._services?.lyrics.destroy();
        this._services?.appearance.destroy();
        this._services = null;
        this._settings = null;

        // Corta qualquer requisição HTTP que ainda esteja no ar.
        this._session?.abort();
        this._session = null;
    }
}
