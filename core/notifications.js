// Watches each quota window across polls and decides when something happened
// worth interrupting the user for: a window falling low, or a window handing
// its quota back.
//
// Emitting is left to the caller — this module produces events and never
// touches a notification API, which is what lets the same rules run under
// GNOME's message tray, osascript on macOS, or a Windows toast.

import {resetMoment} from './format.js';

export const DEFAULT_LOW_PCT = 20;

// A window that rolls over hands quota back, and remaining % is the only
// signal for it: Codex slides reset_at forward on every poll while a window
// sits unused, so the timestamp cannot be trusted to mark the boundary.
//
// Two shapes count as a rollover. A large upward step from anywhere, or any
// real step that lands near full — the second catches a barely-used window
// going 95% to 100%, which the first would miss.
export const DEFAULT_RESET_JUMP_PCT = 10;
const NEAR_FULL_PCT = 95;
// Under this, an increase is the server rounding differently, not a rollover.
const MIN_RESET_STEP_PCT = 1;

const PROVIDER_LABELS = {
    claude: 'Claude',
    codex: 'Codex',
};

const WINDOWS = [
    {key: 'session', label: '5h', pctField: 'sessionRemainingPct', resetField: 'sessionResetsAtIso'},
    {key: 'weekly', label: '7d', pctField: 'weeklyRemainingPct', resetField: 'weeklyResetsAtIso'},
];

function readResetIso(data, field) {
    const value = data?.[field];

    return typeof value === 'string' && value.length > 0 ? value : null;
}

// Remembers one window between polls. Returns the events each reading caused,
// so the decision to notify stays testable without a notification system.
function createWindowWatcher(limits) {
    let previousPct = null;
    let period;
    let lowAlreadyReported = false;

    return {
        read(remainingPct, resetsAtIso) {
            // A new reset timestamp means a new window; whatever we said about
            // the old one does not carry over.
            if (period !== resetsAtIso) {
                period = resetsAtIso;
                lowAlreadyReported = false;
            }

            const previous = previousPct;
            previousPct = remainingPct;

            // Nothing to compare against on the first sighting.
            if (!Number.isFinite(previous))
                return [];

            const events = [];
            const step = remainingPct - previous;

            // Requiring the previous reading to be short of full keeps an idle
            // account from announcing a rollover it never used.
            const rolledOver = previous < 100
                && step >= MIN_RESET_STEP_PCT
                && (step >= limits.resetJumpPct || remainingPct >= NEAR_FULL_PCT);

            if (rolledOver)
                events.push({type: 'reset'});

            if (previous >= limits.lowPct && remainingPct < limits.lowPct && !lowAlreadyReported) {
                events.push({type: 'low'});
                lowAlreadyReported = true;
            }

            // Climbing back above the line re-arms the warning.
            if (remainingPct >= limits.lowPct)
                lowAlreadyReported = false;

            return events;
        },
    };
}

export function createThresholdNotifier(options = {}) {
    const limits = {
        lowPct: options.thresholdPct ?? DEFAULT_LOW_PCT,
        resetJumpPct: options.resetJumpPct ?? DEFAULT_RESET_JUMP_PCT,
    };

    const notify = typeof options.notifyFn === 'function' ? options.notifyFn : () => {};
    // Asked on every event rather than captured once, so toggling the setting
    // takes effect without restarting the extension.
    const resetsWanted = typeof options.shouldNotifyReset === 'function'
        ? options.shouldNotifyReset
        : () => true;

    const watchers = new Map();

    function watcherFor(key) {
        let watcher = watchers.get(key);

        if (!watcher) {
            watcher = createWindowWatcher(limits);
            watchers.set(key, watcher);
        }

        return watcher;
    }

    function announce(event, provider, window, remainingPct, resetsAtIso) {
        const who = `${PROVIDER_LABELS[provider] ?? provider} ${window.label}`;
        const pct = Math.round(remainingPct);

        if (event.type === 'reset') {
            if (!resetsWanted())
                return;

            notify(
                `${who} limit reset`,
                `${pct}% available again — next reset ${resetMoment(resetsAtIso)}`,
                provider,
            );
            return;
        }

        notify(
            `${who} low`,
            `${pct}% remaining — resets ${resetMoment(resetsAtIso)}`,
            provider,
        );
    }

    return {
        evaluate(summary) {
            for (const provider of Object.keys(PROVIDER_LABELS)) {
                const data = summary?.providers?.[provider]?.data;

                if (!data)
                    continue;

                for (const window of WINDOWS) {
                    const remainingPct = data[window.pctField];

                    // A window this provider does not report is not a window
                    // that can cross a threshold.
                    if (!Number.isFinite(remainingPct))
                        continue;

                    const resetsAtIso = readResetIso(data, window.resetField);
                    const events = watcherFor(`${provider}:${window.key}`)
                        .read(remainingPct, resetsAtIso);

                    for (const event of events)
                        announce(event, provider, window, remainingPct, resetsAtIso);
                }
            }
        },
    };
}
