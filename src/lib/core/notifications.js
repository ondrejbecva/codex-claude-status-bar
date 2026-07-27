const DEFAULT_THRESHOLD_PCT = 20;

// Remaining % only ever goes up when a window rolls over, so an upward step is
// the reset signal. (Codex's reset_at slides forward on every poll while the
// window is unused, so the timestamp cannot be used for this.) Two accepted
// shapes: a big jump from anywhere, or any real step that lands near full —
// the latter catches a barely-used window going 95% -> 100%.
const DEFAULT_RESET_JUMP_PCT = 10;
const NEAR_FULL_PCT = 95;
// Below this, an increase is server-side rounding, not a reset.
const MIN_RESET_STEP_PCT = 1;

const PROVIDERS = [
    {key: 'claude', label: 'Claude'},
    {key: 'codex', label: 'Codex'},
];

const WINDOWS = [
    {
        key: 'session',
        label: '5h',
        remainingKey: 'sessionRemainingPct',
        resetKey: 'sessionResetsAtIso',
    },
    {
        key: 'weekly',
        label: '7d',
        remainingKey: 'weeklyRemainingPct',
        resetKey: 'weeklyResetsAtIso',
    },
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// Local time, phrased the way a person would say it: "today 16:20",
// "tomorrow 09:05", "Mon 09:05", "3 Aug 09:05".
export function formatResetMoment(iso, now = Date.now()) {
    if (!iso)
        return '--';

    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return '--';

    const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const dayDelta = Math.round(
        (startOfLocalDay(date) - startOfLocalDay(new Date(now))) / 86_400_000,
    );

    if (dayDelta === 0)
        return `today ${clock}`;

    if (dayDelta === 1)
        return `tomorrow ${clock}`;

    if (dayDelta > 1 && dayDelta < 7)
        return `${WEEKDAYS[date.getDay()]} ${clock}`;

    return `${date.getDate()} ${MONTHS[date.getMonth()]} ${clock}`;
}

function createWindowState(resetPeriod) {
    return {
        previousRemainingPct: null,
        resetPeriod,
        hasNotifiedBelowThreshold: false,
    };
}

export function createThresholdNotifier(options = {}) {
    const thresholdPct = options.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
    const resetJumpPct = options.resetJumpPct ?? DEFAULT_RESET_JUMP_PCT;
    const notifyFn = typeof options.notifyFn === 'function'
        ? options.notifyFn
        : () => {};
    // Read live so the menu toggle takes effect without a restart.
    const shouldNotifyReset = typeof options.shouldNotifyReset === 'function'
        ? options.shouldNotifyReset
        : () => true;
    const state = new Map();

    function evaluate(summary) {
        for (const provider of PROVIDERS) {
            const providerData = summary?.providers?.[provider.key]?.data;
            if (!providerData)
                continue;

            for (const windowDef of WINDOWS) {
                const remainingPct = providerData[windowDef.remainingKey];
                if (!Number.isFinite(remainingPct))
                    continue;

                const resetsAtIso = typeof providerData[windowDef.resetKey] === 'string' && providerData[windowDef.resetKey].length > 0
                    ? providerData[windowDef.resetKey]
                    : null;
                const windowStateKey = `${provider.key}:${windowDef.key}`;
                const windowState = state.get(windowStateKey) ?? createWindowState(resetsAtIso);

                if (windowState.resetPeriod !== resetsAtIso) {
                    windowState.resetPeriod = resetsAtIso;
                    windowState.hasNotifiedBelowThreshold = false;
                }

                const previousRemainingPct = windowState.previousRemainingPct;

                // Quota handed back = the window rolled over. Requiring the
                // previous reading to be below full keeps an idle account quiet.
                const step = remainingPct - previousRemainingPct;
                const wasReset = Number.isFinite(previousRemainingPct)
                    && previousRemainingPct < 100
                    && step >= MIN_RESET_STEP_PCT
                    && (step >= resetJumpPct || remainingPct >= NEAR_FULL_PCT);

                if (wasReset && shouldNotifyReset()) {
                    notifyFn(
                        `${provider.label} ${windowDef.label} limit reset`,
                        `${Math.round(remainingPct)}% available again — next reset ${formatResetMoment(resetsAtIso)}`,
                        provider.key,
                    );
                }

                const crossedThreshold = Number.isFinite(previousRemainingPct)
                    && previousRemainingPct >= thresholdPct
                    && remainingPct < thresholdPct;

                if (crossedThreshold && !windowState.hasNotifiedBelowThreshold) {
                    const title = `${provider.label} ${windowDef.label} low`;
                    const body = `${Math.round(remainingPct)}% remaining — resets ${formatResetMoment(resetsAtIso)}`;

                    notifyFn(title, body, provider.key);
                    windowState.hasNotifiedBelowThreshold = true;
                }

                if (remainingPct >= thresholdPct)
                    windowState.hasNotifiedBelowThreshold = false;

                windowState.previousRemainingPct = remainingPct;
                state.set(windowStateKey, windowState);
            }
        }
    }

    return {
        evaluate,
    };
}
