// The result shape every provider returns, and the vocabulary of things that
// can go wrong. Kept in one place so the poller, the slots and both providers
// agree on it without importing each other.

export function usable(data) {
    return {ok: true, data};
}

// `data` is optional and only meaningful for partial results — a payload that
// failed validation but still carries a window worth showing.
export function failed(code, message, data = null) {
    const result = {ok: false, error: {code, message}};

    if (data)
        result.data = data;

    return result;
}

// HTTP status to failure kind. Only these four say anything specific; every
// other status, 5xx included, is treated as a transport problem worth retrying
// rather than a permanent condition.
const FAILURE_BY_STATUS = new Map([
    [401, 'auth_expired'],
    [403, 'auth_expired'],
    [404, 'schema_changed'],
    [429, 'rate_limited'],
]);

export function failureForStatus(status) {
    return FAILURE_BY_STATUS.get(status) ?? 'network_error';
}

// Both providers treat an unreadable body as the schema having moved rather
// than as a network fault: the request itself succeeded.
export async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}
