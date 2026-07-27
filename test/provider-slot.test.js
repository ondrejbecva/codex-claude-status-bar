import {test} from 'node:test';
import assert from 'node:assert/strict';

import {createProviderSlot, PROVIDER_STATE_CODES} from '../core/provider-slot.js';

const AT = '2026-07-27T12:00:00.000Z';

test('a new slot holds nothing', () => {
    const slot = createProviderSlot('claude');
    const snapshot = slot.snapshot();

    assert.equal(slot.name, 'claude');
    assert.equal(snapshot.code, null);
    assert.equal(snapshot.data, null);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.lastUpdatedAtIso, null);
    assert.equal(snapshot.inFlight, false);
});

test('a successful result lands as OK with no error', () => {
    const slot = createProviderSlot('claude');

    assert.equal(slot.apply({ok: true, data: {sessionRemainingPct: 42}}, 1, AT), true);

    const snapshot = slot.snapshot();
    assert.equal(snapshot.code, PROVIDER_STATE_CODES.OK);
    assert.deepEqual(snapshot.data, {sessionRemainingPct: 42});
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.lastUpdatedAtIso, AT);
});

test('provider failure kinds map onto state codes', () => {
    const cases = [
        ['partial_data', PROVIDER_STATE_CODES.PARTIAL_DATA],
        ['auth_expired', PROVIDER_STATE_CODES.AUTH_EXPIRED],
        ['rate_limited', PROVIDER_STATE_CODES.RATE_LIMITED],
        ['network_error', PROVIDER_STATE_CODES.NETWORK_ERROR],
        ['schema_changed', PROVIDER_STATE_CODES.SCHEMA_CHANGED],
        ['parse_error', PROVIDER_STATE_CODES.SCHEMA_CHANGED],
    ];

    for (const [providerCode, expected] of cases) {
        const slot = createProviderSlot('claude');
        slot.apply({ok: false, error: {code: providerCode, message: 'nope'}}, 1, AT);

        const snapshot = slot.snapshot();
        assert.equal(snapshot.code, expected, providerCode);
        assert.equal(snapshot.error.providerCode, providerCode);
        assert.equal(snapshot.error.message, 'nope');
    }
});

test('an unrecognised failure is treated as a changed schema', () => {
    const slot = createProviderSlot('codex');
    slot.apply({ok: false, error: {code: 'something_new'}}, 1, AT);

    assert.equal(slot.snapshot().code, PROVIDER_STATE_CODES.SCHEMA_CHANGED);
});

test('a partial result keeps whatever data came with it', () => {
    const slot = createProviderSlot('codex');
    slot.apply({
        ok: false,
        data: {weeklyRemainingPct: 80},
        error: {code: 'partial_data'},
    }, 1, AT);

    const snapshot = slot.snapshot();
    assert.deepEqual(snapshot.data, {weeklyRemainingPct: 80});
    assert.equal(snapshot.code, PROVIDER_STATE_CODES.PARTIAL_DATA);
});

test('an overtaken result is discarded rather than applied', () => {
    const slot = createProviderSlot('claude');

    slot.apply({ok: true, data: {sessionRemainingPct: 10}}, 2, AT);
    // Request 1 was issued first but finished last.
    assert.equal(slot.apply({ok: true, data: {sessionRemainingPct: 99}}, 1, AT), false);

    assert.deepEqual(slot.snapshot().data, {sessionRemainingPct: 10});
});

test('a result with the same id as the last one still applies', () => {
    // The poller only ever reuses an id on a retry of the same request, and
    // dropping that would strand the slot mid-flight.
    const slot = createProviderSlot('claude');

    slot.apply({ok: true, data: {sessionRemainingPct: 10}}, 3, AT);
    assert.equal(slot.apply({ok: true, data: {sessionRemainingPct: 20}}, 3, AT), true);

    assert.deepEqual(slot.snapshot().data, {sessionRemainingPct: 20});
});

test('snapshots do not alias the slot', () => {
    const slot = createProviderSlot('claude');
    slot.apply({ok: true, data: {sessionRemainingPct: 50}}, 1, AT);

    const first = slot.snapshot();
    slot.apply({ok: true, data: {sessionRemainingPct: 25}}, 2, AT);

    assert.deepEqual(first.data, {sessionRemainingPct: 50});
});
