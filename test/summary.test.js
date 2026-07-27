import {test} from 'node:test';
import assert from 'node:assert/strict';

import {summarize} from '../core/summary.js';

// A slot is anything with a name and a snapshot(), so tests can use literals.
function slot(name, snapshot) {
    return {
        name,
        snapshot: () => ({
            code: 'OK',
            data: null,
            error: null,
            inFlight: false,
            lastUpdatedAtIso: null,
            ...snapshot,
        }),
    };
}

test('an empty set summarises to nothing', () => {
    assert.deepEqual(summarize([]), {
        providers: {},
        minRemainingPct: null,
        lastUpdatedAtIso: null,
    });
});

test('every slot appears under its own name', () => {
    const summary = summarize([
        slot('claude', {data: {sessionRemainingPct: 90}}),
        slot('codex', {data: {weeklyRemainingPct: 100}}),
    ]);

    assert.deepEqual(Object.keys(summary.providers), ['claude', 'codex']);
    assert.equal(summary.providers.claude.data.sessionRemainingPct, 90);
});

test('the lowest remaining percentage wins, across providers and windows', () => {
    const summary = summarize([
        slot('claude', {data: {sessionRemainingPct: 90, weeklyRemainingPct: 55}}),
        slot('codex', {data: {weeklyRemainingPct: 12}}),
    ]);

    assert.equal(summary.minRemainingPct, 12);
});

test('any *RemainingPct key counts, including ones added later', () => {
    const summary = summarize([
        slot('claude', {data: {sessionRemainingPct: 90, fableRemainingPct: 3}}),
    ]);

    assert.equal(summary.minRemainingPct, 3);
});

test('non-numeric and unrelated fields are ignored', () => {
    const summary = summarize([
        slot('claude', {
            data: {
                sessionRemainingPct: null,
                weeklyRemainingPct: undefined,
                fableRemainingPct: Number.NaN,
                sessionResetsAtIso: '2026-07-27T12:00:00.000Z',
                somethingElse: 5,
            },
        }),
    ]);

    assert.equal(summary.minRemainingPct, null);
});

test('zero is a real percentage, not an absent one', () => {
    const summary = summarize([slot('codex', {data: {weeklyRemainingPct: 0}})]);

    assert.equal(summary.minRemainingPct, 0);
});

test('the newest update timestamp is reported', () => {
    const summary = summarize([
        slot('claude', {lastUpdatedAtIso: '2026-07-27T12:00:00.000Z'}),
        slot('codex', {lastUpdatedAtIso: '2026-07-27T12:03:00.000Z'}),
    ]);

    assert.equal(summary.lastUpdatedAtIso, '2026-07-27T12:03:00.000Z');
});

test('a slot that has never reported does not erase another slot timestamp', () => {
    const summary = summarize([
        slot('claude', {lastUpdatedAtIso: '2026-07-27T12:00:00.000Z'}),
        slot('codex', {lastUpdatedAtIso: null}),
    ]);

    assert.equal(summary.lastUpdatedAtIso, '2026-07-27T12:00:00.000Z');
});

test('a Map of slots works as well as an array', () => {
    const slots = new Map([['claude', slot('claude', {data: {sessionRemainingPct: 7}})]]);

    assert.equal(summarize(slots.values()).minRemainingPct, 7);
});
