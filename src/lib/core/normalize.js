function clampPercent(value) {
    if (!Number.isFinite(value))
        return 0;

    if (value < 0)
        return 0;

    if (value > 100)
        return 100;

    return value;
}

function unixSecondsToIso(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds))
        return null;

    return new Date(seconds * 1000).toISOString();
}

// Claude reports per-model weekly caps as entries in the `limits` array, each
// carrying a scope.model.display_name (e.g. "Fable"). Find one by name,
// case-insensitively, so "Fable" / "Fable 5" both match.
function findModelScopedLimit(payload, nameNeedle) {
    const limits = Array.isArray(payload?.limits) ? payload.limits : [];
    const needle = nameNeedle.toLowerCase();
    return limits.find(limit => {
        const name = limit?.scope?.model?.display_name;
        return typeof name === 'string' && name.toLowerCase().includes(needle);
    }) ?? null;
}

export function normalizeClaudeUsage(payload) {
    const fiveHourUtilization = Number(payload?.five_hour?.utilization);
    const sevenDayUtilization = Number(payload?.seven_day?.utilization);

    const fableLimit = findModelScopedLimit(payload, 'fable');
    const fableUtilization = Number(fableLimit?.percent);

    return {
        data: {
            sessionRemainingPct: clampPercent(100 - fiveHourUtilization),
            weeklyRemainingPct: clampPercent(100 - sevenDayUtilization),
            sessionResetsAtIso: payload?.five_hour?.resets_at ?? null,
            weeklyResetsAtIso: payload?.seven_day?.resets_at ?? null,
            fableRemainingPct: Number.isFinite(fableUtilization)
                ? clampPercent(100 - fableUtilization)
                : null,
            fableResetsAtIso: fableLimit?.resets_at ?? null,
        },
        hasSessionUsage: Number.isFinite(fiveHourUtilization),
        hasWeeklyUsage: Number.isFinite(sevenDayUtilization),
        hasFableUsage: Boolean(fableLimit),
    };
}

// OpenAI's Codex usage schema is not positionally stable: the 5h "session"
// window and the 7d "weekly" window can each appear in either primary_window
// or secondary_window, and one of them may be absent (null). Classify each
// present window by its own duration (limit_window_seconds) instead of trusting
// the slot it arrived in. Anything shorter than a day is the session window;
// anything a day or longer is the weekly window.
const SESSION_MAX_SECONDS = 86400;

function classifyCodexWindows(rateLimit) {
    const candidates = [
        rateLimit?.primary_window,
        rateLimit?.secondary_window,
    ].filter(w => w && typeof w === 'object');

    let sessionWindow = null;
    let weeklyWindow = null;

    for (const w of candidates) {
        const duration = Number(w.limit_window_seconds);
        if (Number.isFinite(duration) && duration < SESSION_MAX_SECONDS)
            sessionWindow = sessionWindow ?? w;
        else
            weeklyWindow = weeklyWindow ?? w;
    }

    return {sessionWindow, weeklyWindow};
}

function windowRemainingPct(window) {
    const used = Number(window?.used_percent);
    return Number.isFinite(used) ? clampPercent(100 - used) : null;
}

export function normalizeCodexUsage(payload) {
    const {sessionWindow, weeklyWindow} = classifyCodexWindows(payload?.rate_limit);

    return {
        data: {
            sessionRemainingPct: windowRemainingPct(sessionWindow),
            weeklyRemainingPct: windowRemainingPct(weeklyWindow),
            sessionResetsAtIso: unixSecondsToIso(sessionWindow?.reset_at),
            weeklyResetsAtIso: unixSecondsToIso(weeklyWindow?.reset_at),
        },
        // "Primary" here means "at least one usable window", so the provider
        // does not treat a single-window response as a schema break.
        hasPrimaryWindow: Boolean(sessionWindow) || Boolean(weeklyWindow),
        hasSecondaryWindow: Boolean(weeklyWindow),
        // A missing 5h window is now the normal Plus-plan shape, not partial
        // data — never hard-fail on it.
        hasPartialData: false,
    };
}
