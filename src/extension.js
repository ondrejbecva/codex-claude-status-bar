import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createScheduler, DEFAULT_POLL_INTERVAL_MS} from './lib/core/scheduler.js';
import {createThresholdNotifier} from './lib/core/notifications.js';
import {createClaudeProvider} from './lib/providers/claude.js';
import {createCodexProvider} from './lib/providers/codex.js';
import {readTextFile} from './lib/runtime/fs.js';
import {createFetch} from './lib/runtime/fetch.js';
import {buildUsageViewModel, PANEL_LABEL_MODES} from './lib/ui/render.js';

const FILL_CLASSES = {
    green: 'usage-fill-green',
    yellow: 'usage-fill-yellow',
    red: 'usage-fill-red',
};

function createWindowWidgets() {
    const box = new St.BoxLayout({
        vertical: true,
        style_class: 'usage-window-row',
    });

    const label = new St.Label({style_class: 'usage-window-label'});

    const track = new St.BoxLayout({style_class: 'usage-progress-track'});
    track.set_x_expand(true);
    const fill = new St.Widget({style_class: 'usage-fill-green'});
    fill._remainingPct = 0;
    track.add_child(fill);

    track.connect('notify::allocation', () => {
        const node = track.get_theme_node();
        if (!node) return;
        const contentBox = node.get_content_box(track.get_allocation_box());
        const contentWidth = contentBox.x2 - contentBox.x1;
        if (contentWidth > 0)
            fill.set_width(Math.round(contentWidth * fill._remainingPct / 100));
    });

    const infoRow = new St.BoxLayout({style_class: 'usage-info-row'});
    infoRow.set_x_expand(true);
    const remainingLabel = new St.Label({text: '-- left'});
    const resetsLabel = new St.Label({text: '--'});
    const spacer = new St.Widget();
    spacer.set_x_expand(true);
    infoRow.add_child(remainingLabel);
    infoRow.add_child(spacer);
    infoRow.add_child(resetsLabel);

    box.add_child(label);
    box.add_child(track);
    box.add_child(infoRow);

    return {box, label, track, fill, remainingLabel, resetsLabel};
}

function createServiceSection() {
    const container = new St.BoxLayout({vertical: true, style_class: 'usage-service-card'});

    const header = new St.BoxLayout({style_class: 'usage-service-header'});
    const nameLabel = new St.Label({style_class: 'usage-service-name'});
    header.add_child(nameLabel);

    const window0 = createWindowWidgets();
    const window1 = createWindowWidgets();

    const warningLabel = new St.Label({style_class: 'usage-warning'});
    warningLabel.hide();

    container.add_child(header);
    container.add_child(window0.box);
    container.add_child(window1.box);
    container.add_child(warningLabel);

    return {container, nameLabel, windows: [window0, window1], warningLabel};
}

const MODE_LABELS = {
    'min': 'All (minimum)',
    'claude-session': 'Claude Session',
    'claude-weekly': 'Claude Weekly',
    'codex-session': 'Codex Session',
    'codex-weekly': 'Codex Weekly',
};

function pctColor(pct) {
    if (!Number.isFinite(pct))
        return '';

    if (pct >= 50)
        return '#a6e3a1';

    const t = Math.max(0, Math.min(1, pct / 50));
    const r = Math.round((1 - t) * 0xf3 + t * 0xf9);
    const g = Math.round((1 - t) * 0x8b + t * 0xe2);
    const b = Math.round((1 - t) * 0xa8 + t * 0xaf);
    return `rgb(${r},${g},${b})`;
}

function iconStyleForFile(extensionPath, iconBasename) {
    return `background-image: url("file://${extensionPath}/icons/${iconBasename}");`;
}

function buildProviderPanelGroup(extensionPath, iconBasename) {
    const group = new St.BoxLayout({
        style_class: 'usage-panel-group',
        y_align: Clutter.ActorAlign.CENTER,
    });

    // Use a plain St.Widget with CSS background-image so the SVG renders with
    // its own embedded colors. St.Icon + Gio.FileIcon gets recolored by the
    // panel's symbolic-icon styling on GNOME Shell.
    const icon = new St.Widget({
        style_class: 'usage-panel-icon',
        style: iconStyleForFile(extensionPath, iconBasename),
        y_align: Clutter.ActorAlign.CENTER,
    });

    const sessionLabel = new St.Label({
        text: '--',
        style_class: 'usage-panel-pct',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const slash = new St.Label({
        text: ' / ',
        style_class: 'usage-panel-sep',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const weeklyLabel = new St.Label({
        text: '--',
        style_class: 'usage-panel-pct',
        y_align: Clutter.ActorAlign.CENTER,
    });

    group.add_child(icon);
    group.add_child(sessionLabel);
    group.add_child(slash);
    group.add_child(weeklyLabel);

    return {group, icon, sessionLabel, weeklyLabel};
}

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(scheduler, settings, extensionPath) {
        super._init(0.0, 'Usage Indicator');

        this._scheduler = scheduler;
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._lastSummary = null;
        this._timerSourceId = 0;
        this._modeItems = [];

        this._outerBox = new St.BoxLayout({
            style_class: 'usage-panel-outer',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelBox = new St.BoxLayout({
            style_class: 'usage-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._claudePanel = buildProviderPanelGroup(extensionPath, this._claudeIconBasename());
        this._codexPanel = buildProviderPanelGroup(extensionPath, this._codexIconBasename());

        this._panelDivider = new St.Label({
            text: ' │ ',
            style_class: 'usage-panel-divider',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelBox.add_child(this._claudePanel.group);
        this._panelBox.add_child(this._panelDivider);
        this._panelBox.add_child(this._codexPanel.group);

        this._fallbackLabel = new St.Label({
            text: '--',
            style_class: 'usage-panel-fallback',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fallbackLabel.hide();

        // PanelMenu.Button uses BinLayout (children overlap) so wrap both
        // panel modes in a single horizontal box that we can swap in/out.
        this._outerBox.add_child(this._panelBox);
        this._outerBox.add_child(this._fallbackLabel);
        this.add_child(this._outerBox);

        this._buildPopup();
        this._startRelativeTimeTimer();

        this._settingsChangedId = this._settings.connect('changed::panel-label-mode', () => {
            this._updateOrnaments();
            this._refreshRelativeTimes();
        });
        this._layoutChangedId = this._settings.connect('changed::panel-layout', () => {
            this._refreshRelativeTimes();
        });
        this._colorizeChangedId = this._settings.connect('changed::panel-colorize', () => {
            this._refreshRelativeTimes();
        });
        this._claudeIconChangedId = this._settings.connect('changed::claude-icon', () => {
            this._refreshIconStyles();
            this._updateClaudeIconOrnaments();
        });
        this._iconStyleChangedId = this._settings.connect('changed::icon-style', () => {
            this._refreshIconStyles();
            if (this._iconStyleItem)
                this._iconStyleItem.setToggleState(
                    this._settings.get_string('icon-style') === 'color',
                );
        });
    }

    _iconStyleSuffix() {
        return this._settings.get_string('icon-style') === 'mono' ? '-mono' : '';
    }

    _claudeIconBasename() {
        const base = this._settings.get_string('claude-icon') === 'code'
            ? 'claude-code'
            : 'claude-star';
        return `${base}${this._iconStyleSuffix()}.svg`;
    }

    _codexIconBasename() {
        return `codex${this._iconStyleSuffix()}.svg`;
    }

    _refreshIconStyles() {
        this._claudePanel.icon.set_style(
            iconStyleForFile(this._extensionPath, this._claudeIconBasename()),
        );
        this._codexPanel.icon.set_style(
            iconStyleForFile(this._extensionPath, this._codexIconBasename()),
        );
    }

    _updateClaudeIconOrnaments() {
        if (!this._claudeIconItems)
            return;

        const current = this._settings.get_string('claude-icon');
        for (const item of this._claudeIconItems) {
            item.setOrnament(
                item._iconKey === current
                    ? PopupMenu.Ornament.DOT
                    : PopupMenu.Ornament.NONE,
            );
        }
    }

    _buildPopup() {
        const menuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._popupBox = new St.BoxLayout({
            vertical: true,
            style_class: 'usage-popup-box',
        });

        this._codexSection = createServiceSection();
        this._codexSection.nameLabel.text = 'Codex';

        this._claudeSection = createServiceSection();
        this._claudeSection.nameLabel.text = 'Claude';

        const separator = new St.Widget({style_class: 'usage-separator'});
        separator.set_x_expand(true);

        const footerRow = new St.BoxLayout({style_class: 'usage-footer-row'});
        footerRow.set_x_expand(true);
        this._versionLabel = new St.Label({text: 'codex-claude-status-bar 1.0.0'});
        this._nextUpdateLabel = new St.Label({text: 'Next update in --'});
        const footerSpacer = new St.Widget();
        footerSpacer.set_x_expand(true);
        footerRow.add_child(this._versionLabel);
        footerRow.add_child(footerSpacer);
        footerRow.add_child(this._nextUpdateLabel);

        this._popupBox.add_child(this._codexSection.container);
        this._popupBox.add_child(this._claudeSection.container);
        this._popupBox.add_child(separator);
        this._popupBox.add_child(footerRow);

        menuItem.add_child(this._popupBox);
        this.menu.addMenuItem(menuItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        this._refreshSignalId = refreshItem.connect('activate', () => {
            void this._scheduler?.refresh();
        });
        this._refreshItem = refreshItem;
        this.menu.addMenuItem(refreshItem);

        const iconStyleItem = new PopupMenu.PopupSwitchMenuItem(
            'Colored icons',
            this._settings.get_string('icon-style') === 'color',
        );
        this._iconStyleToggleSignalId = iconStyleItem.connect('toggled', (_item, state) => {
            this._settings.set_string('icon-style', state ? 'color' : 'mono');
        });
        this._iconStyleItem = iconStyleItem;
        this.menu.addMenuItem(iconStyleItem);

        const colorizeItem = new PopupMenu.PopupSwitchMenuItem(
            'Colorize percentages',
            this._settings.get_boolean('panel-colorize'),
        );
        this._colorizeToggleSignalId = colorizeItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('panel-colorize', state);
        });
        this._colorizeItem = colorizeItem;
        this.menu.addMenuItem(colorizeItem);

        const layoutItem = new PopupMenu.PopupSwitchMenuItem(
            'Per-provider panel layout',
            this._settings.get_string('panel-layout') === 'per-provider',
        );
        this._layoutToggleSignalId = layoutItem.connect('toggled', (_item, state) => {
            this._settings.set_string('panel-layout', state ? 'per-provider' : 'single');
        });
        this._layoutItem = layoutItem;
        this.menu.addMenuItem(layoutItem);

        this._buildClaudeIconSubmenu();
        this._buildDisplaySubmenu();
    }

    _buildClaudeIconSubmenu() {
        const submenu = new PopupMenu.PopupSubMenuMenuItem('Claude icon');
        this._claudeIconItems = [];

        const options = [
            {key: 'star', label: 'Claude (starburst)'},
            {key: 'code', label: 'Claude Code (brackets)'},
        ];

        for (const opt of options) {
            const item = new PopupMenu.PopupMenuItem(opt.label);
            item._iconKey = opt.key;
            item.connect('activate', () => {
                this._settings.set_string('claude-icon', opt.key);
            });
            this._claudeIconItems.push(item);
            submenu.menu.addMenuItem(item);
        }

        this._claudeIconSubmenu = submenu;
        this.menu.addMenuItem(submenu);
        this._updateClaudeIconOrnaments();
    }

    _buildDisplaySubmenu() {
        this._displaySubmenu = new PopupMenu.PopupSubMenuMenuItem('Panel display');
        this._modeItems = [];

        for (const mode of PANEL_LABEL_MODES) {
            const item = new PopupMenu.PopupMenuItem(MODE_LABELS[mode] ?? mode);
            item._modeKey = mode;
            item.connect('activate', () => {
                this._settings.set_string('panel-label-mode', mode);
                // Picking a single-metric mode implies the user wants the
                // legacy single-label panel; force the layout to match so
                // the choice is actually visible.
                this._settings.set_string('panel-layout', 'single');
                if (this._layoutItem)
                    this._layoutItem.setToggleState(false);
            });
            this._modeItems.push(item);
            this._displaySubmenu.menu.addMenuItem(item);
        }

        this._updateOrnaments();
        this.menu.addMenuItem(this._displaySubmenu);
    }

    _updateOrnaments() {
        const current = this._settings.get_string('panel-label-mode');
        for (const item of this._modeItems) {
            item.setOrnament(
                item._modeKey === current
                    ? PopupMenu.Ornament.DOT
                    : PopupMenu.Ornament.NONE,
            );
        }
    }

    _startRelativeTimeTimer() {
        this._timerSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            60,
            () => {
                this._refreshRelativeTimes();
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    _hasData(svc) {
        return svc?.windows?.some(w => !w.remainingText.startsWith('--')) ?? false;
    }

    _formatPctText(window) {
        if (window.remainingText.startsWith('--'))
            return '--';

        return `${window.remainingPct}%`;
    }

    _applyPanelGroup(panel, svc, label5h, label7d, colorize) {
        const sessionWindow = svc.windows[0];
        const weeklyWindow = svc.windows[1];

        panel.sessionLabel.text = `${label5h} ${this._formatPctText(sessionWindow)}`;
        panel.weeklyLabel.text = `${label7d} ${this._formatPctText(weeklyWindow)}`;

        const sessionColor = colorize ? pctColor(sessionWindow.remainingPct) : '';
        const weeklyColor = colorize ? pctColor(weeklyWindow.remainingPct) : '';
        panel.sessionLabel.set_style(sessionColor ? `color: ${sessionColor};` : '');
        panel.weeklyLabel.set_style(weeklyColor ? `color: ${weeklyColor};` : '');
    }

    _updatePanel(vm) {
        const layout = this._settings.get_string('panel-layout');
        const colorize = this._settings.get_boolean('panel-colorize');

        if (layout !== 'per-provider') {
            this._panelBox.hide();
            this._fallbackLabel.show();
            this._fallbackLabel.text = vm.panelLabel;
            this._fallbackLabel.set_style('');
            return;
        }

        this._fallbackLabel.hide();
        this._panelBox.show();

        const codex = vm.services[0];
        const claude = vm.services[1];

        const claudeHasData = this._hasData(claude);
        const codexHasData = this._hasData(codex);

        if (claudeHasData) {
            this._claudePanel.group.show();
            this._applyPanelGroup(this._claudePanel, claude, '5h', '7d', colorize);
        } else {
            this._claudePanel.group.hide();
        }

        if (codexHasData) {
            this._codexPanel.group.show();
            this._applyPanelGroup(this._codexPanel, codex, '5h', '7d', colorize);
        } else {
            this._codexPanel.group.hide();
        }

        this._panelDivider.visible = claudeHasData && codexHasData;

        if (!claudeHasData && !codexHasData) {
            this._panelBox.hide();
            this._fallbackLabel.show();
            this._fallbackLabel.text = '--';
        }
    }

    _refreshRelativeTimes() {
        // Always rebuild — even with null summary we still want panel layout
        // toggles to take effect (otherwise toggling on a fresh shell leaves
        // the bar blank until the next scheduler tick).
        this._applyViewModel(buildUsageViewModel(this._lastSummary, {
            now: Date.now(),
            pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
            panelLabelMode: this._settings.get_string('panel-label-mode'),
        }));
    }

    render(summary) {
        this._lastSummary = summary;
        this._applyViewModel(buildUsageViewModel(summary, {
            now: Date.now(),
            pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
            panelLabelMode: this._settings.get_string('panel-label-mode'),
        }));
    }

    _applyViewModel(vm) {
        this._updatePanel(vm);

        const sections = [this._codexSection, this._claudeSection];

        for (let i = 0; i < vm.services.length; i++) {
            const svc = vm.services[i];
            const section = sections[i];

            section.nameLabel.text = svc.name;

            for (let j = 0; j < svc.windows.length; j++) {
                const w = svc.windows[j];
                const widgets = section.windows[j];

                widgets.label.text = w.label;
                widgets.fill.style_class = FILL_CLASSES[w.dotColor] ?? 'usage-fill-red';
                widgets.fill._remainingPct = w.remainingPct;
                widgets.remainingLabel.text = w.remainingText;
                widgets.resetsLabel.text = w.resetsInText;

                const node = widgets.track.get_theme_node();
                if (node) {
                    const contentBox = node.get_content_box(widgets.track.get_allocation_box());
                    const contentWidth = contentBox.x2 - contentBox.x1;
                    if (contentWidth > 0)
                        widgets.fill.set_width(Math.round(contentWidth * w.remainingPct / 100));
                }
            }

            if (svc.warning) {
                section.warningLabel.text = svc.warning;
                section.warningLabel.show();
            } else {
                section.warningLabel.hide();
            }
        }

        this._versionLabel.text = vm.version;
        this._nextUpdateLabel.text = vm.lastUpdate;
    }

    destroy() {
        if (this._timerSourceId) {
            GLib.source_remove(this._timerSourceId);
            this._timerSourceId = 0;
        }

        if (this._refreshSignalId && this._refreshItem) {
            this._refreshItem.disconnect(this._refreshSignalId);
            this._refreshSignalId = null;
        }

        if (this._settingsChangedId && this._settings) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._layoutChangedId && this._settings) {
            this._settings.disconnect(this._layoutChangedId);
            this._layoutChangedId = null;
        }

        if (this._colorizeChangedId && this._settings) {
            this._settings.disconnect(this._colorizeChangedId);
            this._colorizeChangedId = null;
        }

        if (this._claudeIconChangedId && this._settings) {
            this._settings.disconnect(this._claudeIconChangedId);
            this._claudeIconChangedId = null;
        }

        if (this._iconStyleChangedId && this._settings) {
            this._settings.disconnect(this._iconStyleChangedId);
            this._iconStyleChangedId = null;
        }

        if (this._iconStyleToggleSignalId && this._iconStyleItem) {
            this._iconStyleItem.disconnect(this._iconStyleToggleSignalId);
            this._iconStyleToggleSignalId = null;
        }

        if (this._colorizeToggleSignalId && this._colorizeItem) {
            this._colorizeItem.disconnect(this._colorizeToggleSignalId);
            this._colorizeToggleSignalId = null;
        }

        if (this._layoutToggleSignalId && this._layoutItem) {
            this._layoutItem.disconnect(this._layoutToggleSignalId);
            this._layoutToggleSignalId = null;
        }

        this._settings = null;
        super.destroy();
    }
});

export default class UsageLimitsExtension extends Extension {
    enable() {
        this._fetchRuntime = createFetch();
        const fetchImpl = this._fetchRuntime.fetch;
        const fileReader = readTextFile;

        const claude = createClaudeProvider({
            fetch: fetchImpl,
            readTextFile: fileReader,
        });
        const codex = createCodexProvider({
            fetch: fetchImpl,
            readTextFile: fileReader,
        });
        this._thresholdNotifier = createThresholdNotifier({
            notifyFn: (title, body) => {
                Main.notify(title, body);
            },
        });

        this._scheduler = createScheduler({
            providers: {claude, codex},
            onUpdate: (summary) => {
                this._indicator?.render(summary);
                this._thresholdNotifier?.evaluate(summary);
            },
        });

        this._settings = this.getSettings();
        this._indicator = new UsageIndicator(this._scheduler, this._settings, this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._scheduler.start();
    }

    disable() {
        this._scheduler?.stop();
        this._scheduler = null;
        this._thresholdNotifier = null;

        this._fetchRuntime?.dispose();
        this._fetchRuntime = null;

        if (!this._indicator)
            return;

        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
