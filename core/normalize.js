// Turns each provider's usage payload into the same small record:
// remaining percentage and reset time per window, plus which windows the
// payload actually contained.
//
// Both providers report *consumption*; the UI shows what is left, so every
// figure here is inverted on the way through.

const FULL = 100;
const ONE_DAY_SECONDS = 86_400;

function remainingFrom(usedPercent) {
    const used = Number(usedPercent);

    if (!Number.isFinite(used))
        return null;

    // Providers have been seen reporting slightly over 100 when a window is
    // exhausted, and clock skew can produce a small negative.
    return Math.min(FULL, Math.max(0, FULL - used));
}

function isoFromUnixSeconds(value) {
    const seconds = Number(value);

    if (!Number.isFinite(seconds))
        return null;

    return new Date(seconds * 1000).toISOString();
}

// ---------------------------------------------------------------- Claude ----

// Claude reports its two headline windows as named objects, and per-model caps
// as entries in `limits`, each tagged with the model it applies to. Matching
// the display name loosely means "Fable" keeps working when it becomes
// "Fable 5".
function findModelCap(payload, modelName) {
    const limits = Array.isArray(payload?.limits) ? payload.limits : [];
    const needle = modelName.toLowerCase();

    return limits.find(limit => {
        const name = limit?.scope?.model?.display_name;
        return typeof name === 'string' && name.toLowerCase().includes(needle);
    }) ?? null;
}

export function readClaudeUsage(payload) {
    const sessionRemainingPct = remainingFrom(payload?.five_hour?.utilization);
    const weeklyRemainingPct = remainingFrom(payload?.seven_day?.utilization);

    const fableCap = findModelCap(payload, 'fable');
    const fableRemainingPct = remainingFrom(fableCap?.percent);

    return {
        data: {
            sessionRemainingPct: sessionRemainingPct ?? 0,
            weeklyRemainingPct: weeklyRemainingPct ?? 0,
            sessionResetsAtIso: payload?.five_hour?.resets_at ?? null,
            weeklyResetsAtIso: payload?.seven_day?.resets_at ?? null,
            fableRemainingPct,
            fableResetsAtIso: fableCap?.resets_at ?? null,
        },
        present: {
            session: sessionRemainingPct !== null,
            weekly: weeklyRemainingPct !== null,
            fable: fableCap !== null,
        },
    };
}

// ----------------------------------------------------------------- Codex ----

// OpenAI's payload is not positionally stable: the 5-hour and 7-day windows
// each turn up in either primary_window or secondary_window, and either may be
// absent. Trusting the slot mislabels the readout, so classify each window by
// the duration it declares about itself. Under a day is the session window;
// a day or more is the weekly one.
function sortCodexWindows(rateLimit) {
    const present = [rateLimit?.primary_window, rateLimit?.secondary_window]
        .filter(window => window && typeof window === 'object');

    let session = null;
    let weekly = null;

    for (const window of present) {
        const seconds = Number(window.limit_window_seconds);
        const isSession = Number.isFinite(seconds) && seconds < ONE_DAY_SECONDS;

        if (isSession)
            session ??= window;
        else
            weekly ??= window;
    }

    return {session, weekly};
}

export function readCodexUsage(payload) {
    const {session, weekly} = sortCodexWindows(payload?.rate_limit);

    return {
        data: {
            sessionRemainingPct: remainingFrom(session?.used_percent),
            weeklyRemainingPct: remainingFrom(weekly?.used_percent),
            sessionResetsAtIso: isoFromUnixSeconds(session?.reset_at),
            weeklyResetsAtIso: isoFromUnixSeconds(weekly?.reset_at),
        },
        present: {
            session: session !== null,
            weekly: weekly !== null,
        },
    };
}
