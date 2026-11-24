// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Vinicius Bispo
//
// Janela de preferências da Wavebar Music (GTK 4 + libadwaita).
//
// Este arquivo NÃO roda dentro do GNOME Shell: roda num processo separado
// (o app "Extensões"). Por isso usa Gtk/Adw, e não St/Clutter. As opções vão
// para o GSettings; a extensão escuta "changed" e aplica na hora.
//
// Páginas: "Geral" (ícone no painel, contorno de progresso, aparência, Blur my
// Shell, cache) e "Sobre mim".

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ---------- Sobre mim (edite à vontade) ----------
const AUTHOR = {
    name: 'Vinicius Bispo',
    bio: 'Estudante de desenvolvimento web e criador de extensões para o GNOME. ' +
        'Gosto de deixar o desktop Linux bonito, rápido e em português.',
    github: 'https://github.com/viniciusbispo19',
};

const PROJECTS = [
    ['Luma Dock', 'Dock leve e bonita para o GNOME, com prévias de janela e Music Pill',
        'https://github.com/viniciusbispo19/luma-dock'],
    ['Luma Menu', 'Barra de menus global no estilo do macOS para o GNOME Shell',
        'https://github.com/viniciusbispo19/luma-menu'],
    ['Hiragana Clock', 'Widget de área de trabalho com o dia da semana em hiragana',
        'https://github.com/viniciusbispo19/hiragana-clock'],
    ['Nautilus Vitrine', 'Modo Colunas e painel de pré-visualização para o Arquivos (Nautilus)',
        'https://github.com/viniciusbispo19/nautilus-vitrine'],
];

const BMS_UUID = 'blur-my-shell@aunetx';
const PANEL_MODES = [
    ['compact', 'Compacto'],
    ['expanded', 'Expandido'],
];
const RING_THICKNESS = [
    ['thin', 'Fina'],
    ['medium', 'Média'],
];
const THEMES = [
    ['auto', 'Automático'],
    ['dark', 'Escuro'],
    ['light', 'Claro'],
];

// Lê (sem alterar) as configurações de popup do Blur my Shell, se instalado.
function readBlurMyShell() {
    const dirs = [
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', BMS_UUID]),
        ...GLib.get_system_data_dirs().map(d =>
            GLib.build_filenamev([d, 'gnome-shell', 'extensions', BMS_UUID])),
    ];
    for (const dir of dirs) {
        const schemas = GLib.build_filenamev([dir, 'schemas']);
        if (!GLib.file_test(schemas, GLib.FileTest.IS_DIR))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                schemas, Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup('org.gnome.shell.extensions.blur-my-shell.popup', false);
            if (!schema?.has_key('blur'))
                return {installed: true, popups: false};
            const settings = new Gio.Settings({settings_schema: schema});
            return {installed: true, popups: true, settings};
        } catch {
            return {installed: true, popups: false};
        }
    }
    return {installed: false};
}

// ComboRow ligada a uma chave de texto com <choices> (lista de [id, rótulo]).
function choiceRow(settings, key, title, choices, subtitle = null) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        const index = choices.findIndex(([id]) => id === settings.get_string(key));
        row.selected = Math.max(0, index);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const id = choices[row.selected]?.[0] ?? choices[0][0];
        if (settings.get_string(key) !== id)
            settings.set_string(key, id);
    });
    return row;
}

// Linha com um slider (Gtk.Scale) ligado a uma chave inteira. O valor é
// gravado arredondado a cada movimento: a extensão aplica ao vivo.
function sliderRow(settings, key, title, {min, max, step, unit}) {
    const row = new Adw.ActionRow({title});
    const adjustment = new Gtk.Adjustment({
        lower: min,
        upper: max,
        step_increment: step,
        page_increment: step * 2,
        value: settings.get_int(key),
    });
    const scale = new Gtk.Scale({
        adjustment,
        digits: 0,
        round_digits: 0,
        draw_value: true,
        value_pos: Gtk.PositionType.RIGHT,
        hexpand: true,
        width_request: 220,
        valign: Gtk.Align.CENTER,
    });
    scale.set_format_value_func((_scale, value) => `${Math.round(value)} ${unit}`);
    adjustment.connect('value-changed', () => {
        const value = Math.round(adjustment.value);
        if (settings.get_int(key) !== value)
            settings.set_int(key, value);
    });
    settings.connect(`changed::${key}`, () => {
        if (Math.round(adjustment.value) !== settings.get_int(key))
            adjustment.value = settings.get_int(key);
    });
    row.add_suffix(scale);
    return row;
}

// Abre um link no navegador padrão (Gtk.UriLauncher é a API atual do GTK 4).
function openUri(widget, uri) {
    new Gtk.UriLauncher({uri}).launch(widget.get_root(), null, null);
}

// Linha clicável com ícone de "link externo".
function linkRow(title, subtitle, uri) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    row.connect('activated', () => openUri(row, uri));
    return row;
}

export default class WavebarMusicPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(600, 780);

        const general = new Adw.PreferencesPage({
            title: 'Geral',
            icon_name: 'preferences-system-symbolic',
        });
        general.add(this._panelGroup(settings));
        general.add(this._progressGroup(settings));
        general.add(this._appearanceGroup(settings));
        general.add(this._blurGroup(settings));
        general.add(this._cacheGroup());
        window.add(general);

        window.add(this._aboutMePage());
    }

    // ---------- Geral ----------

    _panelGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Ícone no painel',
            description: 'Compacto mostra só as barrinhas; expandido mostra também a capa, ' +
                'o título e o artista. Sem nenhum player, o ícone some como antes.',
        });

        const show = new Adw.SwitchRow({
            title: 'Mostrar indicador no painel superior',
            subtitle: 'Útil se você usa o wavebar-music-pill na Orla Dock. ' +
                'Desligado, o card também não abre pelo painel.',
        });
        settings.bind('show-panel-indicator', show, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(show);

        const mode = choiceRow(settings, 'panel-mode', 'Modo de exibição', PANEL_MODES);
        group.add(mode);
        const maxWidth = sliderRow(settings, 'expanded-max-width', 'Largura máxima da pílula expandida',
            {min: 140, max: 320, step: 10, unit: 'px'});
        group.add(maxWidth);

        const hover = new Adw.SwitchRow({
            title: 'Expandir ao passar o mouse',
            subtitle: 'No modo compacto, mostra capa e título enquanto o mouse estiver no ícone',
        });
        settings.bind('expand-on-hover', hover, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(hover);

        const trackChange = new Adw.SwitchRow({
            title: 'Expandir ao trocar de faixa',
            subtitle: 'No modo compacto, mostra a nova música por alguns segundos',
        });
        settings.bind('expand-on-track-change', trackChange, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(trackChange);

        const duration = sliderRow(settings, 'track-change-duration',
            'Duração da expansão ao trocar de faixa', {min: 2, max: 10, step: 1, unit: 's'});
        group.add(duration);

        const cover = new Adw.SwitchRow({title: 'Mostrar capa do álbum'});
        settings.bind('show-cover', cover, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(cover);

        const scroll = new Adw.SwitchRow({
            title: 'Rolagem automática do título longo',
            subtitle: 'Desligada, o título que não couber só é esmaecido na borda',
        });
        settings.bind('scroll-long-title', scroll, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(scroll);

        // As opções de "expandir às vezes" só fazem sentido no modo compacto.
        // Com o indicador oculto, nenhuma das outras opções tem efeito.
        const syncSensitive = () => {
            const shown = settings.get_boolean('show-panel-indicator');
            const compact = settings.get_string('panel-mode') === 'compact';
            for (const row of [mode, maxWidth, cover, scroll])
                row.sensitive = shown;
            hover.sensitive = shown && compact;
            trackChange.sensitive = shown && compact;
            duration.sensitive = shown && compact && settings.get_boolean('expand-on-track-change');
        };
        syncSensitive();
        settings.connect('changed::show-panel-indicator', syncSensitive);
        settings.connect('changed::panel-mode', syncSensitive);
        settings.connect('changed::expand-on-track-change', syncSensitive);

        return group;
    }

    _progressGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Contorno de progresso',
            description: 'Um traço em volta da pílula acompanha o tempo da música, ' +
                'começando e terminando no topo. Some em transmissões ao vivo.',
        });

        const show = new Adw.SwitchRow({title: 'Mostrar contorno de progresso'});
        settings.bind('show-progress-ring', show, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(show);

        const dynamic = new Adw.SwitchRow({
            title: 'Cor pela capa do álbum',
            subtitle: 'Desligado (ou sem capa), usa a cor de destaque do sistema',
        });
        settings.bind('progress-ring-dynamic-color', dynamic, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(dynamic);

        const thickness = choiceRow(settings, 'progress-ring-thickness', 'Espessura', RING_THICKNESS);
        group.add(thickness);

        const syncSensitive = () => {
            const on = settings.get_boolean('show-panel-indicator') &&
                settings.get_boolean('show-progress-ring');
            show.sensitive = settings.get_boolean('show-panel-indicator');
            dynamic.sensitive = on;
            thickness.sensitive = on;
        };
        syncSensitive();
        settings.connect('changed::show-panel-indicator', syncSensitive);
        settings.connect('changed::show-progress-ring', syncSensitive);
        return group;
    }

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Aparência',
            description: 'Automático segue o Blur my Shell (se ativo) ou o tema claro/escuro ' +
                'do GNOME. O ícone do painel sempre acompanha o painel.',
        });

        const row = choiceRow(settings, 'theme', 'Tema do card', THEMES);
        group.add(row);
        return group;
    }

    _blurGroup(settings) {
        const bms = readBlurMyShell();
        let status;
        if (!bms.installed)
            status = 'Blur my Shell não está instalado.';
        else if (!bms.popups)
            status = 'Esta versão do Blur my Shell não desfoca menus.';
        else if (bms.settings.get_boolean('blur'))
            status = 'Detectado: o desfoque de menus está ligado.';
        else
            status = 'Detectado, mas o desfoque de menus está desligado nele.';

        const group = new Adw.PreferencesGroup({
            title: 'Blur my Shell',
            description: status,
        });

        const row = new Adw.SwitchRow({
            title: 'Integrar com o Blur my Shell',
            subtitle: 'Usa o fundo desfocado, o estilo claro/escuro e o raio dos cantos ' +
                'configurados nele para menus',
        });
        settings.bind('follow-blur-my-shell', row, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.sensitive = !!bms.popups;
        group.add(row);
        return group;
    }

    _cacheGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Cache',
            description: 'Capas e letras ficam salvas em ~/.cache/wavebar-music para abrir mais rápido.',
        });
        const row = new Adw.ActionRow({title: 'Limpar capas e letras salvas'});
        const button = new Gtk.Button({
            label: 'Limpar',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        button.connect('clicked', () => {
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'wavebar-music']);
            for (const sub of ['covers', 'lyrics']) {
                const folder = Gio.File.new_for_path(GLib.build_filenamev([dir, sub]));
                try {
                    const en = folder.enumerate_children('standard::name',
                        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                    let info;
                    while ((info = en.next_file(null)))
                        folder.get_child(info.get_name()).delete(null);
                } catch {
                    // pasta ainda não existe
                }
            }
            button.label = 'Limpo';
            button.sensitive = false;
        });
        row.add_suffix(button);
        group.add(row);
        return group;
    }

    // ---------- Sobre mim ----------

    _aboutMePage() {
        const page = new Adw.PreferencesPage({
            title: 'Sobre mim',
            icon_name: 'avatar-default-symbolic',
        });

        // Cabeçalho: avatar com iniciais (sem baixar foto nenhuma da internet),
        // nome, bio e botão para o GitHub.
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            margin_bottom: 6,
        });
        header.append(new Adw.Avatar({size: 96, text: AUTHOR.name, show_initials: true}));
        header.append(new Gtk.Label({label: AUTHOR.name, css_classes: ['title-1']}));
        header.append(new Gtk.Label({
            label: AUTHOR.bio,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            max_width_chars: 48,
            css_classes: ['dim-label'],
        }));
        const github = new Gtk.Button({
            label: 'Meu GitHub',
            halign: Gtk.Align.CENTER,
            margin_top: 4,
            css_classes: ['pill', 'suggested-action'],
        });
        github.connect('clicked', () => openUri(github, AUTHOR.github));
        header.append(github);

        const headerGroup = new Adw.PreferencesGroup();
        headerGroup.add(header);
        page.add(headerGroup);

        const projects = new Adw.PreferencesGroup({
            title: 'Meus outros projetos para o GNOME',
        });
        for (const [title, subtitle, uri] of PROJECTS)
            projects.add(linkRow(title, subtitle, uri));
        page.add(projects);

        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        const about = new Adw.PreferencesGroup({title: 'Sobre a Wavebar Music'});
        about.add(new Adw.ActionRow({
            title: 'Versão',
            subtitle: version,
        }));
        about.add(linkRow('Código-fonte', this.metadata.url, this.metadata.url));
        about.add(linkRow('Relatar um problema ou sugerir algo',
            'Abra uma issue no GitHub', `${this.metadata.url}/issues`));
        about.add(linkRow('Licença', 'GNU GPL 3.0 ou posterior — software livre',
            `${this.metadata.url}/blob/main/LICENSE`));
        about.add(linkRow('Letras', 'Fornecidas pelo LRCLIB (lrclib.net)', 'https://lrclib.net'));
        page.add(about);

        return page;
    }
}
