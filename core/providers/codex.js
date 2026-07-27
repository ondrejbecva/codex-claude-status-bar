import {readCodexUsage} from '../normalize.js';
import {createUsageProvider} from './usage-provider.js';

export const CODEX_ENDPOINTS = {
    credentialsPath: '~/.codex/auth.json',
    refreshEndpoint: 'https://auth.openai.com/oauth/token',
    usageEndpoint: 'https://chatgpt.com/backend-api/wham/usage',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
};

export const codexSpec = {
    name: 'codex',
    ...CODEX_ENDPOINTS,

    readTokens(credentials) {
        const tokens = credentials?.tokens;
        if (!tokens)
            return null;

        return {
            accessToken: tokens.access_token ?? null,
            refreshToken: tokens.refresh_token ?? null,
            // auth.json records no expiry, so the stored token is tried as-is
            // and refreshed only if the endpoint rejects it.
            expiresAt: null,
            // Accounts with more than one workspace need this to disambiguate.
            accountId: tokens.account_id ?? null,
        };
    },

    readRefreshedToken(payload) {
        return payload?.access_token ?? null;
    },

    usageHeaders(accessToken, tokens) {
        const headers = {authorization: `Bearer ${accessToken}`};

        if (tokens?.accountId)
            headers['ChatGPT-Account-Id'] = tokens.accountId;

        return headers;
    },

    read: readCodexUsage,

    // A missing 5-hour window is the normal shape on some plans rather than a
    // fault — Codex CLI's own /status drops its 5h line in the same case — so
    // only a payload with no windows at all counts as broken. This is
    // deliberately laxer than Claude's rule.
    inspect(present) {
        if (!present.session && !present.weekly)
            return {code: 'schema_changed', message: 'Usage payload has no rate-limit windows'};

        return null;
    },
};

export function createCodexProvider(options = {}) {
    return createUsageProvider(codexSpec, options);
}
