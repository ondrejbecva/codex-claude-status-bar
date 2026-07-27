// One provider's latest known state.
//
// A slot owns its data and hands out immutable snapshots; nothing outside
// reaches in and assigns. Poll results can land out of order (a slow request
// overtaken by the manual Refresh behind it), so every result carries the id of
// the request that produced it and a stale one is dropped rather than applied.

export const PROVIDER_STATE_CODES = {
    OK: 'OK',
    PARTIAL_DATA: 'PARTIAL_DATA',
    AUTH_EXPIRED: 'AUTH_EXPIRED',
    RATE_LIMITED: 'RATE_LIMITED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    SCHEMA_CHANGED: 'SCHEMA_CHANGED',
};

// Providers report lowercase failure kinds; the UI speaks these. Anything
// unrecognised is treated as the payload having changed shape under us, which
// is the failure we most want to notice.
const STATE_CODE_BY_FAILURE = {
    partial_data: PROVIDER_STATE_CODES.PARTIAL_DATA,
    auth_expired: PROVIDER_STATE_CODES.AUTH_EXPIRED,
    rate_limited: PROVIDER_STATE_CODES.RATE_LIMITED,
    network_error: PROVIDER_STATE_CODES.NETWORK_ERROR,
    schema_changed: PROVIDER_STATE_CODES.SCHEMA_CHANGED,
    parse_error: PROVIDER_STATE_CODES.SCHEMA_CHANGED,
};

function stateCodeFor(result) {
    if (result?.ok)
        return PROVIDER_STATE_CODES.OK;

    return STATE_CODE_BY_FAILURE[result?.error?.code]
        ?? PROVIDER_STATE_CODES.SCHEMA_CHANGED;
}

export function createProviderSlot(name) {
    let stateCode = null;
    let data = null;
    let failure = null;
    let updatedAtIso = null;
    let newestApplied = 0;

    return {
        name,

        // Public because the poller flips it around an in-flight request and
        // the UI shows a spinner off it.
        inFlight: false,

        // Returns whether the result was taken; false means it was overtaken.
        apply(result, requestId, atIso) {
            if (requestId < newestApplied)
                return false;

            newestApplied = requestId;
            stateCode = stateCodeFor(result);
            updatedAtIso = atIso;

            // A partial result still carries usable data, so keep whatever came
            // with it regardless of whether the call succeeded overall.
            data = result?.data ?? null;
            failure = result?.ok
                ? null
                : {
                    code: stateCode,
                    providerCode: result?.error?.code ?? null,
                    message: result?.error?.message ?? null,
                };

            return true;
        },

        snapshot() {
            return {
                code: stateCode,
                data,
                error: failure,
                inFlight: this.inFlight,
                lastUpdatedAtIso: updatedAtIso,
            };
        },
    };
}
