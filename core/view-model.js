// Turns a poller summary into exactly what a UI needs to draw, with no
// decisions left for the widget layer: every number already rounded, every
// string already phrased, every colour already chosen.
//
// Platform-free on purpose — the GNOME popup, a menu-bar script and a tray
// window all render from this same object.

import {
    nextUpdateLabel,
    quotaTier,
    remainingLabel,
    resetsInLabel,
} from './format.js';

export const VERSION = 'codex-claude-status-bar 1.4.0';

const DEFAULT_POLL_INTERVAL_MS = 180_000;

// Popup order, top to bottom. Each provider names the fields its windows live
// in, so adding a window is a table edit rather than a new branch.
const SERVICES = [
    {
        key: 'codex',
        name: 'Codex',
        windows: [
            {label: 'Session', pctField: 'sessionRemainingPct', resetField: 'sessionResetsAtIso'},
            {label: 'Weekly', pctField: 'weeklyRemainingPct', resetField: 'weeklyResetsAtIso'},
        ],
    },
    {
        key: 'claude',
        name: 'Claude',
        windows: [
            {label: 'Session', pctField: 'sessionRemainingPct', resetField: 'sessionResetsAtIso'},
            {label: 'Weekly', pctField: 'weeklyRemainingPct', resetField: 'weeklyResetsAtIso'},
            // Only assembled when the Fable toggle is on.
            {label: 'Fable', pctField: 'fableRemainingPct', resetField: 'fableResetsAtIso', optional: 'fable'},
        ],
    },
];

const WARNINGS = {
    AUTH_EXPIRED: 'authentication expired',
    PARTIAL_DATA: 'partial usage data',
    NETWORK_ERROR: 'network error',
    SCHEMA_CHANGED: 'schema changed',
};

function warningFor(serviceName, stateCode) {
    const reason = WARNINGS[stateCode];

    return reason ? `${serviceName}: ${reason}` : '';
}

function buildWindow(spec, data, now) {
    const remainingPct = data?.[spec.pctField];
    const resetsAtIso = data?.[spec.resetField];

    return {
        label: spec.label,
        // A window with no reading still has to occupy its row, so it draws as
        // an empty bar rather than being absent.
        remainingPct: Number.isFinite(remainingPct) ? Math.round(remainingPct) : 0,
        remainingText: remainingLabel(remainingPct),
        resetsInText: resetsInLabel(resetsAtIso, now),
        dotColor: quotaTier(remainingPct),
    };
}

export function buildUsageViewModel(summary, options = {}) {
    const now = options.now ?? Date.now();
    const version = options.version ?? VERSION;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    // Which optional windows the user has switched on.
    const enabled = new Set(options.showClaudeFable ? ['fable'] : []);

    const services = SERVICES.map(service => {
        const state = summary?.providers?.[service.key] ?? null;

        return {
            key: service.key,
            name: service.name,
            windows: service.windows
                .filter(spec => !spec.optional || enabled.has(spec.optional))
                .map(spec => buildWindow(spec, state?.data, now)),
            warning: warningFor(service.name, state?.code),
        };
    });

    return {
        services,
        version,
        lastUpdate: nextUpdateLabel(summary?.lastUpdatedAtIso, pollIntervalMs, now),
    };
}
