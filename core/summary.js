// Folds every provider slot into the single object the UI renders from.

// Providers name their metrics themselves (sessionRemainingPct,
// weeklyRemainingPct, fableRemainingPct, …), so rather than maintain a list
// that has to be edited every time a provider grows a window, treat the suffix
// as the contract and pick up whatever is there.
const REMAINING_SUFFIX = 'RemainingPct';

function* remainingPercentages(data) {
    if (!data || typeof data !== 'object')
        return;

    for (const [key, value] of Object.entries(data)) {
        if (key.endsWith(REMAINING_SUFFIX) && Number.isFinite(value))
            yield value;
    }
}

// Takes anything iterable of slots — the poller holds a Map, tests pass an
// array.
export function summarize(slots) {
    const providers = {};
    let lowestRemainingPct = null;
    let newestUpdateIso = null;

    for (const slot of slots) {
        const snapshot = slot.snapshot();
        providers[slot.name] = snapshot;

        for (const pct of remainingPercentages(snapshot.data)) {
            if (lowestRemainingPct === null || pct < lowestRemainingPct)
                lowestRemainingPct = pct;
        }

        // ISO-8601 UTC strings sort lexicographically, so no parsing needed.
        const {lastUpdatedAtIso} = snapshot;
        if (lastUpdatedAtIso && (newestUpdateIso === null || lastUpdatedAtIso > newestUpdateIso))
            newestUpdateIso = lastUpdatedAtIso;
    }

    return {
        providers,
        minRemainingPct: lowestRemainingPct,
        lastUpdatedAtIso: newestUpdateIso,
    };
}
