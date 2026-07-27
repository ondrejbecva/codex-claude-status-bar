import {test} from 'node:test';
import assert from 'node:assert/strict';

import {createClaudeProvider} from '../core/providers/claude.js';
import {createCodexProvider} from '../core/providers/codex.js';

const FIVE_HOURS = 5 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

const CLAUDE_CREDS = JSON.stringify({
    claudeAiOauth: {accessToken: 'live-token', refreshToken: 'refresh-token'},
});

const CODEX_CREDS = JSON.stringify({
    tokens: {access_token: 'live-token', refresh_token: 'refresh-token', account_id: 'acct-1'},
});

const CLAUDE_USAGE = {
    five_hour: {utilization: 10, resets_at: '2026-07-27T16:20:00Z'},
    seven_day: {utilization: 20, resets_at: '2026-08-01T00:00:00Z'},
};

const CODEX_USAGE = {
    rate_limit: {
        primary_window: {limit_window_seconds: SEVEN_DAYS, used_percent: 0},
        secondary_window: null,
    },
};

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
            if (body === undefined)
                throw new Error('not json');

            return body;
        },
    };
}

// Records every call and replies from a queue keyed loosely by URL.
function transport(handlers) {
    const calls = [];

    const fetchImpl = async (url, options = {}) => {
        calls.push({url, options});

        for (const [needle, reply] of handlers) {
            if (url.includes(needle))
                return typeof reply === 'function' ? reply(calls.length) : reply;
        }

        throw new Error(`unexpected request to ${url}`);
    };

    return {fetchImpl, calls};
}

const readsFile = contents => async () => contents;

// ---------------------------------------------------------------- Claude ----

test('claude returns normalised data on the happy path', async () => {
    const {fetchImpl, calls} = transport([['oauth/usage', response(200, CLAUDE_USAGE)]]);

    const provider = createClaudeProvider({
        fetch: fetchImpl,
        readTextFile: readsFile(CLAUDE_CREDS),
        homeDir: '/home/test',
    });

    const result = await provider.getUsage();

    assert.equal(result.ok, true);
    assert.equal(result.data.sessionRemainingPct, 90);
    assert.equal(result.data.weeklyRemainingPct, 80);

    // A live token is used as-is, with no refresh round trip.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.authorization, 'Bearer live-token');
    assert.equal(calls[0].options.headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('the credentials path is resolved against the home directory', async () => {
    let seenPath = null;

    const {fetchImpl} = transport([['oauth/usage', response(200, CLAUDE_USAGE)]]);
    const provider = createClaudeProvider({
        fetch: fetchImpl,
        readTextFile: async path => {
            seenPath = path;
            return CLAUDE_CREDS;
        },
        homeDir: '/home/test',
    });

    await provider.getUsage();

    assert.equal(seenPath, '/home/test/.claude/.credentials.json');
});

test('an expired stored token is refreshed before the usage call', async () => {
    const {fetchImpl, calls} = transport([
        ['oauth/token', response(200, {access_token: 'fresh-token'})],
        ['oauth/usage', response(200, CLAUDE_USAGE)],
    ]);

    const provider = createClaudeProvider({
        fetch: fetchImpl,
        readTextFile: readsFile(JSON.stringify({
            claudeAiOauth: {
                accessToken: 'stale-token',
                refreshToken: 'refresh-token',
                expiresAt: 1_000_000,
            },
        })),
        now: () => 2_000_000 * 1000,
    });

    const result = await provider.getUsage();

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.includes('oauth/token'), true);
    assert.equal(calls[1].options.headers.authorization, 'Bearer fresh-token');
});

test('a token rejected at the endpoint is refreshed once and retried', async () => {
    const {fetchImpl, calls} = transport([
        ['oauth/token', response(200, {access_token: 'fresh-token'})],
        // First usage call is rejected, the retry succeeds.
        ['oauth/usage', n => (n === 1 ? response(401) : response(200, CLAUDE_USAGE))],
    ]);

    const provider = createClaudeProvider({
        fetch: fetchImpl,
        readTextFile: readsFile(CLAUDE_CREDS),
    });

    const result = await provider.getUsage();

    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].options.headers.authorization, 'Bearer fresh-token');
});

test('the retry is not repeated forever', async () => {
    const {fetchImpl, calls} = transport([
        ['oauth/token', response(200, {access_token: 'fresh-token'})],
        ['oauth/usage', response(401)],
    ]);

    const provider = createClaudeProvider({
        fetch: fetchImpl,
        readTextFile: readsFile(CLAUDE_CREDS),
    });

    const result = await provider.getUsage();

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'auth_expired');
    // usage, refresh, usage — and then it gives up.
    assert.equal(calls.length, 3);
});

test('when the retry refresh also fails, its failure is what surfaces', async () => {
    const {fetchImpl} = transport([
        ['oauth/token', response(400)],
        ['oauth/usage', response(401)],
    ]);

    const provider = createClaudeProvider({
        fetch: fetchImpl,
        readTextFile: readsFile(CLAUDE_CREDS),
    });

    const result = await provider.getUsage();

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'network_error');
});

test('http statuses map onto failure kinds', async () => {
    const cases = [
        [401, 'auth_expired'],
        [403, 'auth_expired'],
        [404, 'schema_changed'],
        [429, 'rate_limited'],
        [500, 'network_error'],
        [418, 'network_error'],
    ];

    for (const [status, expected] of cases) {
        // No refresh token, so an auth failure cannot be retried away.
        const {fetchImpl} = transport([['oauth/usage', response(status)]]);
        const provider = createClaudeProvider({
            fetch: fetchImpl,
            readTextFile: readsFile(JSON.stringify({claudeAiOauth: {accessToken: 'live-token'}})),
        });

        const result = await provider.getUsage();
        assert.equal(result.ok, false, String(status));
        assert.equal(result.error.code, expected, String(status));
    }
});

test('a missing credentials file is reported, not thrown', async () => {
    const provider = createClaudeProvider({
        fetch: async () => response(200, CLAUDE_USAGE),
        readTextFile: async () => {
            throw new Error('ENOENT');
        },
    });

    const result = await provider.getUsage();

    assert.equal(result.error.code, 'missing_creds');
});

test('unparseable credentials are reported as a parse error', async () => {
    const provider = createClaudeProvider({
        fetch: async () => response(200, CLAUDE_USAGE),
        readTextFile: readsFile('{ not json'),
    });

    assert.equal((await provider.getUsage()).error.code, 'parse_error');
});

test('credentials without the oauth block are reported as missing', async () => {
    const provider = createClaudeProvider({
        fetch: async () => response(200, CLAUDE_USAGE),
        readTextFile: readsFile(JSON.stringify({somethingElse: true})),
    });

    assert.equal((await provider.getUsage()).error.code, 'missing_creds');
});

test('a usage payload with no utilization figures is a schema change', async () => {
    const {fetchImpl} = transport([['oauth/usage', response(200, {})]]);
    const provider = createClaudeProvider({fetch: fetchImpl, readTextFile: readsFile(CLAUDE_CREDS)});

    assert.equal((await provider.getUsage()).error.code, 'schema_changed');
});

test('one missing claude window is partial data, and the data is kept', async () => {
    const {fetchImpl} = transport([
        ['oauth/usage', response(200, {five_hour: {utilization: 10}})],
    ]);
    const provider = createClaudeProvider({fetch: fetchImpl, readTextFile: readsFile(CLAUDE_CREDS)});

    const result = await provider.getUsage();

    assert.equal(result.error.code, 'partial_data');
    assert.equal(result.data.sessionRemainingPct, 90);
});

test('an unreadable body is a schema change rather than a network fault', async () => {
    const {fetchImpl} = transport([['oauth/usage', response(200, undefined)]]);
    const provider = createClaudeProvider({fetch: fetchImpl, readTextFile: readsFile(CLAUDE_CREDS)});

    assert.equal((await provider.getUsage()).error.code, 'schema_changed');
});

test('a transport that throws becomes a network error', async () => {
    const provider = createClaudeProvider({
        fetch: async () => {
            throw new Error('connection reset');
        },
        readTextFile: readsFile(CLAUDE_CREDS),
    });

    assert.equal((await provider.getUsage()).error.code, 'network_error');
});

// ----------------------------------------------------------------- Codex ----

test('codex returns normalised data and sends the account header', async () => {
    const {fetchImpl, calls} = transport([['wham/usage', response(200, CODEX_USAGE)]]);

    const provider = createCodexProvider({
        fetch: fetchImpl,
        readTextFile: readsFile(CODEX_CREDS),
        homeDir: '/home/test',
    });

    const result = await provider.getUsage();

    assert.equal(result.ok, true);
    assert.equal(result.data.weeklyRemainingPct, 100);
    assert.equal(calls[0].options.headers['ChatGPT-Account-Id'], 'acct-1');
});

test('codex omits the account header when there is no account id', async () => {
    const {fetchImpl, calls} = transport([['wham/usage', response(200, CODEX_USAGE)]]);

    const provider = createCodexProvider({
        fetch: fetchImpl,
        readTextFile: readsFile(JSON.stringify({tokens: {access_token: 'live-token'}})),
    });

    await provider.getUsage();

    assert.equal('ChatGPT-Account-Id' in calls[0].options.headers, false);
});

test('a codex payload with only a weekly window succeeds', async () => {
    // The regression this project exists for: never fail on a missing 5h window.
    const {fetchImpl} = transport([['wham/usage', response(200, CODEX_USAGE)]]);
    const provider = createCodexProvider({fetch: fetchImpl, readTextFile: readsFile(CODEX_CREDS)});

    const result = await provider.getUsage();

    assert.equal(result.ok, true);
    assert.equal(result.data.sessionRemainingPct, null);
    assert.equal(result.data.weeklyRemainingPct, 100);
});

test('a codex payload with both windows succeeds', async () => {
    const {fetchImpl} = transport([['wham/usage', response(200, {
        rate_limit: {
            primary_window: {limit_window_seconds: FIVE_HOURS, used_percent: 25},
            secondary_window: {limit_window_seconds: SEVEN_DAYS, used_percent: 5},
        },
    })]]);
    const provider = createCodexProvider({fetch: fetchImpl, readTextFile: readsFile(CODEX_CREDS)});

    const result = await provider.getUsage();

    assert.equal(result.data.sessionRemainingPct, 75);
    assert.equal(result.data.weeklyRemainingPct, 95);
});

test('a codex payload with no windows is a schema change', async () => {
    const {fetchImpl} = transport([['wham/usage', response(200, {rate_limit: {}})]]);
    const provider = createCodexProvider({fetch: fetchImpl, readTextFile: readsFile(CODEX_CREDS)});

    assert.equal((await provider.getUsage()).error.code, 'schema_changed');
});

test('codex refreshes when the file holds only a refresh token', async () => {
    const {fetchImpl, calls} = transport([
        ['oauth/token', response(200, {access_token: 'fresh-token'})],
        ['wham/usage', response(200, CODEX_USAGE)],
    ]);

    const provider = createCodexProvider({
        fetch: fetchImpl,
        readTextFile: readsFile(JSON.stringify({tokens: {refresh_token: 'refresh-token'}})),
    });

    const result = await provider.getUsage();

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers.authorization, 'Bearer fresh-token');
});

test('codex credentials with no tokens at all are reported missing', async () => {
    const provider = createCodexProvider({
        fetch: async () => response(200, CODEX_USAGE),
        readTextFile: readsFile(JSON.stringify({tokens: {}})),
    });

    assert.equal((await provider.getUsage()).error.code, 'missing_creds');
});

test('providers carry their own name for the poller', () => {
    assert.equal(createClaudeProvider().name, 'claude');
    assert.equal(createCodexProvider().name, 'codex');
});

test('a provider without a readTextFile fails cleanly', async () => {
    const provider = createClaudeProvider({fetch: async () => response(200, CLAUDE_USAGE)});

    assert.equal((await provider.getUsage()).error.code, 'missing_creds');
});
