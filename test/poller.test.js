import {test} from 'node:test';
import assert from 'node:assert/strict';

import {createPoller} from '../core/poller.js';

const AT = '2026-07-27T12:00:00.000Z';

// A provider whose pending calls are resolved by the test, so ordering is
// deterministic rather than timing-dependent.
function deferredProvider() {
    const pending = [];

    return {
        calls: 0,
        settle(index, result) {
            pending[index](result);
        },
        getUsage() {
            this.calls += 1;
            return new Promise(resolve => pending.push(resolve));
        },
    };
}

function immediateProvider(result) {
    return {
        calls: 0,
        getUsage() {
            this.calls += 1;
            return Promise.resolve(result);
        },
    };
}

const baseOptions = {
    nowIso: () => AT,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
};

test('refresh polls every provider and returns the summary', async () => {
    const claude = immediateProvider({ok: true, data: {sessionRemainingPct: 80}});
    const codex = immediateProvider({ok: true, data: {weeklyRemainingPct: 40}});

    const poller = createPoller({...baseOptions, providers: {claude, codex}});
    const summary = await poller.refresh();

    assert.equal(claude.calls, 1);
    assert.equal(codex.calls, 1);
    assert.equal(summary.minRemainingPct, 40);
    assert.equal(summary.providers.claude.code, 'OK');
    assert.equal(summary.lastUpdatedAtIso, AT);
});

test('a provider that throws is recorded as a network error, not a crash', async () => {
    const thrower = {
        getUsage() {
            throw new Error('socket died');
        },
    };

    const poller = createPoller({...baseOptions, providers: {claude: thrower}});
    const summary = await poller.refresh();

    assert.equal(summary.providers.claude.code, 'NETWORK_ERROR');
    assert.equal(summary.providers.claude.error.providerCode, 'network_error');
});

test('one provider failing does not stop the other from reporting', async () => {
    const claude = immediateProvider({ok: false, error: {code: 'auth_expired'}});
    const codex = immediateProvider({ok: true, data: {weeklyRemainingPct: 40}});

    const poller = createPoller({...baseOptions, providers: {claude, codex}});
    const summary = await poller.refresh();

    assert.equal(summary.providers.claude.code, 'AUTH_EXPIRED');
    assert.equal(summary.providers.codex.data.weeklyRemainingPct, 40);
});

test('subscribers see in-flight state and then the result', async () => {
    const claude = immediateProvider({ok: true, data: {sessionRemainingPct: 80}});
    const seen = [];

    const poller = createPoller({
        ...baseOptions,
        providers: {claude},
        onUpdate: summary => seen.push(summary.providers.claude.inFlight),
    });

    await poller.refresh();

    assert.deepEqual(seen, [true, false]);
});

test('a paused provider is skipped entirely', async () => {
    const claude = immediateProvider({ok: false, error: {code: 'rate_limited'}});

    const poller = createPoller({...baseOptions, providers: {claude}});

    await poller.refresh();
    assert.equal(claude.calls, 1);

    // The 429 bought a pause, so the next round must not call out again.
    await poller.refresh();
    assert.equal(claude.calls, 1);
});

test('a pause on one provider does not hold up the other', async () => {
    const claude = immediateProvider({ok: false, error: {code: 'rate_limited'}});
    const codex = immediateProvider({ok: true, data: {weeklyRemainingPct: 40}});

    const poller = createPoller({...baseOptions, providers: {claude, codex}});

    await poller.refresh();
    await poller.refresh();

    assert.equal(claude.calls, 1);
    assert.equal(codex.calls, 2);
});

test('polls of one provider are serialised, and a stale answer loses', async () => {
    const claude = deferredProvider();
    const poller = createPoller({...baseOptions, providers: {claude}});

    const first = poller.refresh();
    await Promise.resolve();
    assert.equal(claude.calls, 1);

    // A second refresh queues behind the first rather than running alongside.
    const second = poller.refresh();
    await Promise.resolve();
    assert.equal(claude.calls, 1);

    claude.settle(0, {ok: true, data: {sessionRemainingPct: 10}});
    await first;

    assert.equal(claude.calls, 2);
    claude.settle(1, {ok: true, data: {sessionRemainingPct: 20}});
    await second;

    assert.equal(poller.getSummary().providers.claude.data.sessionRemainingPct, 20);
});

test('start polls immediately and stop clears the timer', async () => {
    const claude = immediateProvider({ok: true, data: {}});
    let cleared = null;

    const poller = createPoller({
        ...baseOptions,
        providers: {claude},
        setIntervalFn: () => 'timer-1',
        clearIntervalFn: id => {
            cleared = id;
        },
    });

    poller.start();
    // The first poll is queued on the provider's chain rather than run inline,
    // so let the microtask queue drain before looking.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(claude.calls, 1);

    // Starting twice must not stack a second timer.
    poller.start();

    poller.stop();
    assert.equal(cleared, 'timer-1');

    poller.stop();
});

test('providers may be supplied as an array carrying their own names', async () => {
    const provider = {...immediateProvider({ok: true, data: {}}), name: 'codex'};

    const poller = createPoller({...baseOptions, providers: [provider]});
    const summary = await poller.refresh();

    assert.deepEqual(Object.keys(summary.providers), ['codex']);
});

test('a provider without getUsage is ignored rather than fatal', async () => {
    const poller = createPoller({...baseOptions, providers: {broken: {}}});
    const summary = await poller.refresh();

    assert.equal(summary.providers.broken.code, null);
});
