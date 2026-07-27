import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createScheduler, DEFAULT_POLL_INTERVAL_MS} from './lib/core/scheduler.js';
import {createThresholdNotifier} from './lib/core/notifications.js';
import {createClaudeProvider} from './lib/providers/claude.js';
import {createCodexProvider} from './lib/providers/codex.js';
import {readTextFile} from './lib/runtime/fs.js';
import {createFetch} from './lib/runtime/fetch.js';
import {buildUsageViewModel} from './lib/ui/render.js';

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

function createServiceSection(windowCount = 2) {
    const container = new St.BoxLayout({vertical: true, style_class: 'usage-service-card'});

    const header = new St.BoxLayout({style_class: 'usage-service-header'});
    const nameLabel = new St.Label({style_class: 'usage-service-name'});
    header.add_child(nameLabel);
    container.add_child(header);

    const windows = [];
    for (let i = 0; i < windowCount; i++) {
        const w = createWindowWidgets();
        windows.push(w);
        container.add_child(w.box);
    }

    const warningLabel = new St.Label({style_class: 'usage-warning'});
    warningLabel.hide();
    container.add_child(warningLabel);

    return {container, nameLabel, windows, warningLabel};
}

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

function buildProviderPanelGroup(extensionPath, iconBasename, withFable = false) {
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

    const result = {group, icon, sessionLabel, slash, weeklyLabel};

    if (withFable) {
        const fableSlash = new St.Label({
            text: ' / ',
            style_class: 'usage-panel-sep',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const fableLabel = new St.Label({
            text: '--',
            style_class: 'usage-panel-pct',
            y_align: Clutter.ActorAlign.CENTER,
        });
        fableSlash.hide();
        fableLabel.hide();
        group.add_child(fableSlash);
        group.add_child(fableLabel);
        result.fableSlash = fableSlash;
        result.fableLabel = fableLabel;
    }

    return result;
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

        this._outerBox = new St.BoxLayout({
            style_class: 'usage-panel-outer',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelBox = new St.BoxLayout({
            style_class: 'usage-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._claudePanel = buildProviderPanelGroup(extensionPath, this._claudeIconBasename(), true);
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

        this._panelSettingIds = [];
        for (const key of [
            'panel-colorize',
            'show-claude-fable',
            'show-claude',
            'show-codex',
            'claude-panel-windows',
            'codex-panel-windows',
        ]) {
            this._panelSettingIds.push(this._settings.connect(`changed::${key}`, () => {
                this._updateProviderOrnaments();
                this._refreshRelativeTimes();
            }));
        }
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

        // Claude gets a third window widget for the optional Fable row.
        this._claudeSection = createServiceSection(3);
        this._claudeSection.nameLabel.text = 'Claude';

        const separator = new St.Widget({style_class: 'usage-separator'});
        separator.set_x_expand(true);

        const footerRow = new St.BoxLayout({style_class: 'usage-footer-row'});
        footerRow.set_x_expand(true);
        this._versionLabel = new St.Label({text: 'codex-claude-status-bar 1.3.0'});
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

        const resetNotifyItem = new PopupMenu.PopupSwitchMenuItem(
            'Notify on limit reset',
            this._settings.get_boolean('notify-window-reset'),
        );
        this._resetNotifyToggleSignalId = resetNotifyItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('notify-window-reset', state);
        });
        this._resetNotifyItem = resetNotifyItem;
        this.menu.addMenuItem(resetNotifyItem);

        this._windowItems = {};
        this._showItems = {};

        this._claudeSubmenu = this._buildProviderSubmenu({
            title: 'Claude',
            provider: 'claude',
            showKey: 'show-claude',
            windowsKey: 'claude-panel-windows',
            extras: submenu => this._addClaudeExtras(submenu),
        });
        this._codexSubmenu = this._buildProviderSubmenu({
            title: 'Codex',
            provider: 'codex',
            showKey: 'show-codex',
            windowsKey: 'codex-panel-windows',
        });
    }

    // One submenu per provider: whether it appears in the top bar at all, and
    // which of its windows are shown there.
    _buildProviderSubmenu({title, provider, showKey, windowsKey, extras}) {
        const submenu = new PopupMenu.PopupSubMenuMenuItem(title);

        const showItem = new PopupMenu.PopupSwitchMenuItem(
            'Show in top bar',
            this._settings.get_boolean(showKey),
        );
        showItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean(showKey, state);
        });
        this._showItems[provider] = showItem;
        submenu.menu.addMenuItem(showItem);

        submenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const options = [
            {key: 'both', label: '5h + 7d'},
            {key: 'session', label: '5h only'},
            {key: 'weekly', label: '7d only'},
        ];

        this._windowItems[provider] = [];
        for (const opt of options) {
            const item = new PopupMenu.PopupMenuItem(opt.label);
            item._windowsKey = opt.key;
            item.connect('activate', () => {
                this._settings.set_string(windowsKey, opt.key);
            });
            this._windowItems[provider].push(item);
            submenu.menu.addMenuItem(item);
        }
        this._updateWindowOrnaments(provider, windowsKey);

        extras?.(submenu);

        this.menu.addMenuItem(submenu);
        return submenu;
    }

    _addClaudeExtras(submenu) {
        submenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const fableItem = new PopupMenu.PopupSwitchMenuItem(
            'Show Fable usage',
            this._settings.get_boolean('show-claude-fable'),
        );
        this._fableToggleSignalId = fableItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('show-claude-fable', state);
        });
        this._fableItem = fableItem;
        submenu.menu.addMenuItem(fableItem);

        submenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._claudeIconItems = [];
        const icons = [
            {key: 'star', label: 'Icon: Claude (starburst)'},
            {key: 'code', label: 'Icon: Claude Code (brackets)'},
        ];

        for (const opt of icons) {
            const item = new PopupMenu.PopupMenuItem(opt.label);
            item._iconKey = opt.key;
            item.connect('activate', () => {
                this._settings.set_string('claude-icon', opt.key);
            });
            this._claudeIconItems.push(item);
            submenu.menu.addMenuItem(item);
        }

        this._updateClaudeIconOrnaments();
    }

    _updateWindowOrnaments(provider, windowsKey) {
        const current = this._settings.get_string(windowsKey);
        for (const item of this._windowItems[provider] ?? []) {
            item.setOrnament(
                item._windowsKey === current
                    ? PopupMenu.Ornament.DOT
                    : PopupMenu.Ornament.NONE,
            );
        }
    }

    // Keep the menu in sync when a key changes from outside (dconf, another
    // toggle in this menu).
    _updateProviderOrnaments() {
        if (!this._windowItems)
            return;

        this._updateWindowOrnaments('claude', 'claude-panel-windows');
        this._updateWindowOrnaments('codex', 'codex-panel-windows');

        this._showItems.claude?.setToggleState(this._settings.get_boolean('show-claude'));
        this._showItems.codex?.setToggleState(this._settings.get_boolean('show-codex'));
        this._fableItem?.setToggleState(this._settings.get_boolean('show-claude-fable'));
        this._colorizeItem?.setToggleState(this._settings.get_boolean('panel-colorize'));
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

    _hasWindowData(window) {
        return Boolean(window) && !window.remainingText.startsWith('--');
    }

    _hasData(svc) {
        return svc?.windows?.some(w => this._hasWindowData(w)) ?? false;
    }

    _formatPctText(window) {
        if (window.remainingText.startsWith('--'))
            return '--';

        return `${window.remainingPct}%`;
    }

    _applyPanelGroup(panel, svc, colorize, windowsMode) {
        const sessionWindow = svc.windows[0];
        const weeklyWindow = svc.windows[1];

        // A window the provider does not report at all (Codex currently has no
        // 5h window on Plus) would only ever render as "5h --", so drop it
        // instead of parking dead text in the bar.
        const showSession = windowsMode !== 'weekly' && this._hasWindowData(sessionWindow);
        const showWeekly = windowsMode !== 'session' && this._hasWindowData(weeklyWindow);

        panel.sessionLabel.text = `5h ${this._formatPctText(sessionWindow)}`;
        panel.weeklyLabel.text = `7d ${this._formatPctText(weeklyWindow)}`;

        const sessionColor = colorize ? pctColor(sessionWindow.remainingPct) : '';
        const weeklyColor = colorize ? pctColor(weeklyWindow.remainingPct) : '';
        panel.sessionLabel.set_style(sessionColor ? `color: ${sessionColor};` : '');
        panel.weeklyLabel.set_style(weeklyColor ? `color: ${weeklyColor};` : '');

        panel.sessionLabel.visible = showSession;
        panel.weeklyLabel.visible = showWeekly;
        // The separator only earns its place between two visible percentages.
        panel.slash.visible = showSession && showWeekly;

        // Optional Fable segment (Claude group only). The Fable window is
        // present in the view-model only when the toggle is on.
        if (panel.fableLabel) {
            const fableWindow = svc.windows[2];
            if (fableWindow && !fableWindow.remainingText.startsWith('--')) {
                panel.fableLabel.text = `F ${this._formatPctText(fableWindow)}`;
                const fableColor = colorize ? pctColor(fableWindow.remainingPct) : '';
                panel.fableLabel.set_style(fableColor ? `color: ${fableColor};` : '');
                panel.fableSlash.show();
                panel.fableLabel.show();
            } else {
                panel.fableSlash.hide();
                panel.fableLabel.hide();
            }
        }

        return showSession || showWeekly || Boolean(panel.fableLabel?.visible);
    }

    // Returns whether the group ended up with anything to show.
    _applyProviderPanel(panel, svc, colorize, showKey, windowsKey) {
        if (!this._settings.get_boolean(showKey) || !this._hasData(svc)) {
            panel.group.hide();
            return false;
        }

        const visible = this._applyPanelGroup(
            panel, svc, colorize, this._settings.get_string(windowsKey),
        );
        panel.group.visible = visible;
        return visible;
    }

    _updatePanel(vm) {
        const colorize = this._settings.get_boolean('panel-colorize');

        this._fallbackLabel.hide();
        this._panelBox.show();

        const codex = vm.services[0];
        const claude = vm.services[1];

        const showClaude = this._applyProviderPanel(
            this._claudePanel, claude, colorize, 'show-claude', 'claude-panel-windows',
        );
        const showCodex = this._applyProviderPanel(
            this._codexPanel, codex, colorize, 'show-codex', 'codex-panel-windows',
        );

        this._panelDivider.visible = showClaude && showCodex;

        if (!showClaude && !showCodex) {
            this._panelBox.hide();
            this._fallbackLabel.show();
            this._fallbackLabel.text = '--';
        }
    }

    _refreshRelativeTimes() {
        // Always rebuild — even with null summary we still want setting
        // toggles to take effect (otherwise toggling on a fresh shell leaves
        // the bar blank until the next scheduler tick).
        this._applyViewModel(buildUsageViewModel(this._lastSummary, {
            now: Date.now(),
            pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
            showClaudeFable: this._settings.get_boolean('show-claude-fable'),
        }));
    }

    render(summary) {
        this._lastSummary = summary;
        this._applyViewModel(buildUsageViewModel(summary, {
            now: Date.now(),
            pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
            showClaudeFable: this._settings.get_boolean('show-claude-fable'),
        }));
    }

    _applyViewModel(vm) {
        this._updatePanel(vm);

        const sections = [this._codexSection, this._claudeSection];

        for (let i = 0; i < vm.services.length; i++) {
            const svc = vm.services[i];
            const section = sections[i];

            section.nameLabel.text = svc.name;

            // A section may own more widgets than the view-model has windows
            // (Claude's Fable row is optional) — hide the surplus.
            for (let j = 0; j < section.windows.length; j++) {
                const w = svc.windows[j];
                const widgets = section.windows[j];

                if (!w) {
                    widgets.box.hide();
                    continue;
                }
                widgets.box.show();

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

        if (this._panelSettingIds && this._settings) {
            for (const id of this._panelSettingIds)
                this._settings.disconnect(id);
            this._panelSettingIds = [];
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

        if (this._fableToggleSignalId && this._fableItem) {
            this._fableItem.disconnect(this._fableToggleSignalId);
            this._fableToggleSignalId = null;
        }

        if (this._resetNotifyToggleSignalId && this._resetNotifyItem) {
            this._resetNotifyItem.disconnect(this._resetNotifyToggleSignalId);
            this._resetNotifyToggleSignalId = null;
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
        this._settings = this.getSettings();

        this._thresholdNotifier = createThresholdNotifier({
            notifyFn: (title, body, providerKey) => {
                this._notify(title, body, providerKey);
            },
            shouldNotifyReset: () => this._settings?.get_boolean('notify-window-reset') ?? true,
        });

        this._scheduler = createScheduler({
            providers: {claude, codex},
            onUpdate: (summary) => {
                this._indicator?.render(summary);
                this._thresholdNotifier?.evaluate(summary);
            },
        });

        this._indicator = new UsageIndicator(this._scheduler, this._settings, this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._scheduler.start();
    }

    // Main.notify() posts to the shell's generic system source, which cannot
    // carry a custom icon — own the source so notifications wear the provider's
    // mark instead of the default bell.
    _notificationIcon(providerKey) {
        const basename = providerKey === 'codex'
            ? 'codex.svg'
            : this._settings?.get_string('claude-icon') === 'code'
                ? 'claude-code.svg'
                : 'claude-star.svg';

        return Gio.icon_new_for_string(`${this.path}/icons/${basename}`);
    }

    _ensureNotificationSource() {
        if (this._notificationSource)
            return this._notificationSource;

        const source = new MessageTray.Source({
            title: 'AI usage limits',
            icon: this._notificationIcon('claude'),
        });
        source.connect('destroy', () => {
            this._notificationSource = null;
        });

        Main.messageTray.add(source);
        this._notificationSource = source;
        return source;
    }

    _notify(title, body, providerKey) {
        const source = this._ensureNotificationSource();

        source.addNotification(new MessageTray.Notification({
            source,
            title,
            body,
            gicon: this._notificationIcon(providerKey),
        }));
    }

    disable() {
        this._scheduler?.stop();
        this._scheduler = null;
        this._thresholdNotifier = null;

        this._notificationSource?.destroy();
        this._notificationSource = null;

        this._fetchRuntime?.dispose();
        this._fetchRuntime = null;

        if (!this._indicator)
            return;

        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
