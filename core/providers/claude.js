import {readClaudeUsage} from '../normalize.js';
import {createUsageProvider} from './usage-provider.js';

export const CLAUDE_ENDPOINTS = {
    credentialsPath: '~/.claude/.credentials.json',
    refreshEndpoint: 'https://platform.claude.com/v1/oauth/token',
    usageEndpoint: 'https://api.anthropic.com/api/oauth/usage',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
};

// The usage endpoint is behind the OAuth beta, and refuses the request without
// this header.
const BETA_HEADER = 'oauth-2025-04-20';

// Claude Code has written the token under several names across versions; take
// whichever is present rather than pinning to one.
function firstPresent(source, keys) {
    for (const key of keys) {
        if (source?.[key] !== undefined && source?.[key] !== null)
            return source[key];
    }

    return null;
}

const ACCESS_TOKEN_KEYS = ['accessToken', 'access_token', 'token'];
const REFRESH_TOKEN_KEYS = ['refreshToken', 'refresh_token'];
const EXPIRY_KEYS = ['expiresAt', 'expires_at', 'expiry'];

export const claudeSpec = {
    name: 'claude',
    ...CLAUDE_ENDPOINTS,

    readTokens(credentials) {
        // Claude Code nests its OAuth material under this key; anything else in
        // the file belongs to other features.
        const oauth = credentials?.claudeAiOauth;
        if (!oauth)
            return null;

        return {
            accessToken: firstPresent(oauth, ACCESS_TOKEN_KEYS),
            refreshToken: firstPresent(oauth, REFRESH_TOKEN_KEYS),
            expiresAt: firstPresent(oauth, EXPIRY_KEYS),
        };
    },

    readRefreshedToken(payload) {
        return firstPresent(payload, ACCESS_TOKEN_KEYS);
    },

    usageHeaders(accessToken) {
        return {
            'authorization': `Bearer ${accessToken}`,
            'anthropic-beta': BETA_HEADER,
        };
    },

    read: readClaudeUsage,

    // Claude always reports both headline windows. Neither present means the
    // payload moved; exactly one means we can still show something useful, so
    // report it as partial and keep the data.
    inspect(present) {
        if (!present.session && !present.weekly)
            return {code: 'schema_changed', message: 'Usage payload has no utilization figures'};

        if (!present.session || !present.weekly) {
            return {
                code: 'partial_data',
                message: 'Usage payload is missing one utilization figure',
                keepData: true,
            };
        }

        return null;
    },
};

export function createClaudeProvider(options = {}) {
    return createUsageProvider(claudeSpec, options);
}
