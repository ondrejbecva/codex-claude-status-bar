// Both providers do the same job: read an OAuth credential file the vendor's
// CLI already wrote, get a live access token out of it, call one usage
// endpoint, and hand back a normalised record. Only the details differ, so the
// sequence lives here once and each provider supplies a spec describing its
// own paths, payload shapes and validation.
//
// Nothing in here imports a platform API. The caller injects `fetch` and
// `readTextFile`, which is what lets the same provider run inside GNOME Shell
// under libsoup and inside Node under global fetch.

import {failed, failureForStatus, readJson, usable} from '../result.js';

function expandHome(path, homeDir) {
    if (homeDir && path.startsWith('~/'))
        return `${homeDir}${path.slice(1)}`;

    return path;
}

// Credential files record expiry as epoch seconds, epoch milliseconds or an
// ISO string depending on the vendor and the version. Absent or unparseable
// means "no opinion", and we let the request find out.
function hasExpired(expiresAt, now) {
    if (expiresAt === null || expiresAt === undefined)
        return false;

    if (typeof expiresAt === 'number') {
        const millis = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
        return now >= millis;
    }

    const parsed = Date.parse(expiresAt);
    return Number.isNaN(parsed) ? false : now >= parsed;
}

export function createUsageProvider(spec, options = {}) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const readTextFile = options.readTextFile ?? null;
    const homeDir = options.homeDir ?? globalThis.process?.env?.HOME ?? null;
    const now = options.now ?? (() => Date.now());
    const credentialsPath = expandHome(spec.credentialsPath, homeDir);

    async function loadCredentials() {
        if (typeof readTextFile !== 'function')
            return failed('missing_creds', 'No readTextFile was provided for this runtime');

        let raw;
        try {
            raw = await readTextFile(credentialsPath);
        } catch {
            return failed('missing_creds', `Missing credentials at ${credentialsPath}`);
        }

        if (!raw)
            return failed('missing_creds', `Missing credentials at ${credentialsPath}`);

        try {
            return usable(JSON.parse(raw));
        } catch {
            return failed('parse_error', `Unable to parse ${spec.name} credentials JSON`);
        }
    }

    async function exchangeRefreshToken(refreshToken) {
        if (!refreshToken)
            return failed('auth_expired', 'OAuth refresh token is missing');

        const response = await fetchImpl(spec.refreshEndpoint, {
            method: 'POST',
            headers: {'content-type': 'application/x-www-form-urlencoded'},
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: spec.clientId,
            }),
        });

        if (!response.ok) {
            return failed(
                failureForStatus(response.status),
                `Token refresh failed with status ${response.status}`,
            );
        }

        const payload = await readJson(response);
        if (!payload)
            return failed('schema_changed', 'Token refresh returned invalid JSON');

        const accessToken = spec.readRefreshedToken(payload);
        if (!accessToken)
            return failed('auth_expired', 'Token refresh returned no access token');

        return usable(accessToken);
    }

    async function requestUsage(tokens, accessToken) {
        const response = await fetchImpl(spec.usageEndpoint, {
            method: 'GET',
            headers: spec.usageHeaders(accessToken, tokens),
        });

        if (!response.ok) {
            return failed(
                failureForStatus(response.status),
                `Usage request failed with status ${response.status}`,
            );
        }

        const payload = await readJson(response);
        if (!payload)
            return failed('schema_changed', 'Usage endpoint returned invalid JSON');

        return usable(payload);
    }

    return {
        name: spec.name,

        async getUsage() {
            if (typeof fetchImpl !== 'function')
                return failed('network_error', 'No fetch implementation is available');

            const credentials = await loadCredentials();
            if (!credentials.ok)
                return credentials;

            const tokens = spec.readTokens(credentials.data);
            if (!tokens || (!tokens.accessToken && !tokens.refreshToken))
                return failed('missing_creds', `No usable ${spec.name} tokens in credentials JSON`);

            try {
                let accessToken = tokens.accessToken;

                // Spend a refresh up front only when the token we hold is
                // absent or known to be stale; otherwise try it and refresh
                // reactively, which costs one request less in the common case.
                if (!accessToken || hasExpired(tokens.expiresAt, now())) {
                    const refreshed = await exchangeRefreshToken(tokens.refreshToken);
                    if (!refreshed.ok)
                        return refreshed;

                    accessToken = refreshed.data;
                }

                let usage = await requestUsage(tokens, accessToken);

                // The stored token can be revoked or expired without the file
                // saying so. One refresh-and-retry, then take the answer.
                if (!usage.ok && usage.error.code === 'auth_expired') {
                    const refreshed = await exchangeRefreshToken(tokens.refreshToken);
                    if (!refreshed.ok)
                        return refreshed;

                    usage = await requestUsage(tokens, refreshed.data);
                }

                if (!usage.ok)
                    return usage;

                const reading = spec.read(usage.data);
                const complaint = spec.inspect(reading.present);

                if (complaint)
                    return failed(complaint.code, complaint.message, complaint.keepData ? reading.data : null);

                return usable(reading.data);
            } catch {
                return failed('network_error', `Network request failed while calling ${spec.name} APIs`);
            }
        },
    };
}
