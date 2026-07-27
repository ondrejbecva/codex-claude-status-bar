import {test} from 'node:test';
import assert from 'node:assert/strict';

import {createRetryPacer} from '../core/retry.js';

function pacerAt(clock, options = {}) {
    return createRetryPacer({now: () => clock.ms, firstPenaltyMs: 1000, maxPenaltyMs: 8000, ...options});
}

const ok = {ok: true, data: {}};
const fail = code => ({ok: false, error: {code}});

test('a fresh provider is never paused', () => {
    const pacer = pacerAt({ms: 0});

    assert.equal(pacer.isPaused('claude'), false);
    assert.equal(pacer.pausedUntilMs('claude'), 0);
});

test('rate limiting pauses from the very first occurrence', () => {
    const clock = {ms: 0};
    const pacer = pacerAt(clock);

    assert.equal(pacer.record('claude', fail('rate_limited')), 1000);
    assert.equal(pacer.isPaused('claude'), true);

    clock.ms = 999;
    assert.equal(pacer.isPaused('claude'), true);

    clock.ms = 1000;
    assert.equal(pacer.isPaused('claude'), false);
});

test('a lone network error is forgiven, a second one is not', () => {
    const clock = {ms: 0};
    const pacer = pacerAt(clock);

    assert.equal(pacer.record('codex', fail('network_error')), 0);
    assert.equal(pacer.isPaused('codex'), false);

    assert.equal(pacer.record('codex', fail('network_error')), 1000);
    assert.equal(pacer.isPaused('codex'), true);
});

test('pauses double per penalty and stop at the ceiling', () => {
    const clock = {ms: 0};
    const pacer = pacerAt(clock);

    assert.equal(pacer.record('claude', fail('rate_limited')), 1000);
    assert.equal(pacer.record('claude', fail('rate_limited')), 2000);
    assert.equal(pacer.record('claude', fail('rate_limited')), 4000);
    assert.equal(pacer.record('claude', fail('rate_limited')), 8000);
    // Capped, not 16000.
    assert.equal(pacer.record('claude', fail('rate_limited')), 8000);
});

test('success clears the record, so the next penalty starts small again', () => {
    const clock = {ms: 0};
    const pacer = pacerAt(clock);

    pacer.record('claude', fail('rate_limited'));
    pacer.record('claude', fail('rate_limited'));

    assert.equal(pacer.record('claude', ok), 0);
    assert.equal(pacer.isPaused('claude'), false);
    assert.equal(pacer.pausedUntilMs('claude'), 0);

    assert.equal(pacer.record('claude', fail('rate_limited')), 1000);
});

test('failures that backing off cannot help never pause', () => {
    const pacer = pacerAt({ms: 0});

    for (const code of ['auth_expired', 'schema_changed', 'parse_error', 'partial_data']) {
        assert.equal(pacer.record('claude', fail(code)), 0, code);
        assert.equal(pacer.isPaused('claude'), false, code);
    }
});

test('a network error breaks a rate-limit streak but not the escalation', () => {
    const clock = {ms: 0};
    const pacer = pacerAt(clock);

    assert.equal(pacer.record('claude', fail('rate_limited')), 1000);

    // New kind, so its own streak starts — one network error is still free.
    assert.equal(pacer.record('claude', fail('network_error')), 0);
    // But the provider has already served a penalty, so the next is longer.
    assert.equal(pacer.record('claude', fail('network_error')), 2000);
});

test('providers are paced independently', () => {
    const clock = {ms: 0};
    const pacer = pacerAt(clock);

    pacer.record('claude', fail('rate_limited'));

    assert.equal(pacer.isPaused('claude'), true);
    assert.equal(pacer.isPaused('codex'), false);
});
