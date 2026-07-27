// Decides when a provider has earned a rest.
//
// Failures are not equal. A 429 is the server explicitly asking us to slow
// down, so it counts from the first occurrence. A single network error is
// usually a suspended laptop or a flapping VPN and resolves by itself, so it
// only counts once it repeats. Everything else — auth trouble, an unreadable
// payload, success — clears the record, because backing off would not help.

export const DEFAULT_FIRST_PENALTY_MS = 30_000;
export const DEFAULT_MAX_PENALTY_MS = 15 * 60_000;

// Consecutive failures of a kind before it starts costing a pause. A kind
// absent from this table never earns one.
const PENALTY_AFTER = {
    rate_limited: 1,
    network_error: 2,
};

function blankRecord() {
    return {kind: null, streak: 0, penaltiesServed: 0, pausedUntilMs: 0};
}

export function createRetryPacer(options = {}) {
    const firstPenaltyMs = options.firstPenaltyMs ?? DEFAULT_FIRST_PENALTY_MS;
    const maxPenaltyMs = options.maxPenaltyMs ?? DEFAULT_MAX_PENALTY_MS;
    const now = options.now ?? (() => Date.now());

    const records = new Map();

    function recordFor(providerName) {
        let record = records.get(providerName);

        if (!record) {
            record = blankRecord();
            records.set(providerName, record);
        }

        return record;
    }

    // Doubles per penalty served, capped. `served` is 1 for the first one.
    function pauseLengthMs(served) {
        return Math.min(maxPenaltyMs, firstPenaltyMs * 2 ** (served - 1));
    }

    return {
        // Timestamp this provider may be polled again, 0 when it is free.
        pausedUntilMs(providerName) {
            return recordFor(providerName).pausedUntilMs;
        },

        isPaused(providerName) {
            return now() < recordFor(providerName).pausedUntilMs;
        },

        // Feed every poll outcome through here. Returns the pause imposed in
        // milliseconds, or 0 when the outcome did not earn one.
        record(providerName, result) {
            const record = recordFor(providerName);
            const kind = result?.ok ? null : result?.error?.code ?? null;
            const threshold = kind === null ? undefined : PENALTY_AFTER[kind];

            if (threshold === undefined) {
                Object.assign(record, blankRecord());
                return 0;
            }

            // A different kind of failure starts its own streak, but the
            // escalation already served is not forgiven — a provider failing in
            // two alternating ways is still a provider in trouble.
            record.streak = kind === record.kind ? record.streak + 1 : 1;
            record.kind = kind;

            if (record.streak < threshold)
                return 0;

            record.penaltiesServed += 1;
            const pauseMs = pauseLengthMs(record.penaltiesServed);
            record.pausedUntilMs = now() + pauseMs;

            return pauseMs;
        },
    };
}
