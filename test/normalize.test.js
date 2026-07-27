import {test} from 'node:test';
import assert from 'node:assert/strict';

import {readClaudeUsage, readCodexUsage} from '../core/normalize.js';

// ---------------------------------------------------------------- Claude ----

test('claude utilization is inverted into remaining', () => {
    const {data, present} = readClaudeUsage({
        five_hour: {utilization: 7, resets_at: '2026-07-27T16:20:00Z'},
        seven_day: {utilization: 45, resets_at: '2026-08-01T00:00:00Z'},
    });

    assert.equal(data.sessionRemainingPct, 93);
    assert.equal(data.weeklyRemainingPct, 55);
    assert.equal(data.sessionResetsAtIso, '2026-07-27T16:20:00Z');
    assert.equal(data.weeklyResetsAtIso, '2026-08-01T00:00:00Z');
    assert.deepEqual(present, {session: true, weekly: true, fable: false});
});

test('claude utilization outside 0-100 is clamped', () => {
    const over = readClaudeUsage({five_hour: {utilization: 105}, seven_day: {utilization: -3}});

    assert.equal(over.data.sessionRemainingPct, 0);
    assert.equal(over.data.weeklyRemainingPct, 100);
});

test('claude windows absent from the payload are reported absent', () => {
    const {present} = readClaudeUsage({});

    assert.deepEqual(present, {session: false, weekly: false, fable: false});
});

test('a claude window present but unparseable counts as absent', () => {
    const {present} = readClaudeUsage({
        five_hour: {utilization: 'lots'},
        seven_day: {utilization: 45},
    });

    assert.equal(present.session, false);
    assert.equal(present.weekly, true);
});

test('the fable cap is found by model display name, case-insensitively', () => {
    const {data, present} = readClaudeUsage({
        five_hour: {utilization: 0},
        seven_day: {utilization: 0},
        limits: [
            {scope: {model: {display_name: 'Opus'}}, percent: 90},
            {scope: {model: {display_name: 'FABLE 5'}}, percent: 12, resets_at: '2026-08-01T00:00:00Z'},
        ],
    });

    assert.equal(data.fableRemainingPct, 88);
    assert.equal(data.fableResetsAtIso, '2026-08-01T00:00:00Z');
    assert.equal(present.fable, true);
});

test('no fable cap leaves the field null rather than zero', () => {
    const {data, present} = readClaudeUsage({five_hour: {utilization: 0}, seven_day: {utilization: 0}});

    assert.equal(data.fableRemainingPct, null);
    assert.equal(data.fableResetsAtIso, null);
    assert.equal(present.fable, false);
});

test('a malformed limits array does not throw', () => {
    assert.equal(readClaudeUsage({limits: 'nope'}).present.fable, false);
    assert.equal(readClaudeUsage({limits: [null, {}, {scope: {}}]}).present.fable, false);
});

// ----------------------------------------------------------------- Codex ----

const FIVE_HOURS = 5 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;

test('codex windows are classified by their declared duration, not their slot', () => {
    // Weekly arriving in the primary slot is the shape OpenAI moved to.
    const {data, present} = readCodexUsage({
        rate_limit: {
            primary_window: {limit_window_seconds: SEVEN_DAYS, used_percent: 0, reset_at: 1785312000},
            secondary_window: {limit_window_seconds: FIVE_HOURS, used_percent: 30, reset_at: 1785000000},
        },
    });

    assert.equal(data.weeklyRemainingPct, 100);
    assert.equal(data.sessionRemainingPct, 70);
    assert.deepEqual(present, {session: true, weekly: true});
});

test('a single weekly window is a complete reading, not a broken one', () => {
    // The Plus-plan shape: no 5h window at all.
    const {data, present} = readCodexUsage({
        rate_limit: {
            primary_window: {limit_window_seconds: SEVEN_DAYS, used_percent: 0},
            secondary_window: null,
        },
    });

    assert.equal(data.weeklyRemainingPct, 100);
    assert.equal(data.sessionRemainingPct, null);
    assert.deepEqual(present, {session: false, weekly: true});
});

test('codex reset timestamps convert from unix seconds to ISO', () => {
    const {data} = readCodexUsage({
        rate_limit: {primary_window: {limit_window_seconds: SEVEN_DAYS, used_percent: 0, reset_at: 1785312000}},
    });

    assert.equal(data.weeklyResetsAtIso, new Date(1785312000 * 1000).toISOString());
});

test('a missing codex reset timestamp stays null', () => {
    const {data} = readCodexUsage({
        rate_limit: {primary_window: {limit_window_seconds: SEVEN_DAYS, used_percent: 0}},
    });

    assert.equal(data.weeklyResetsAtIso, null);
});

test('a window without a usable duration is treated as weekly', () => {
    // Better to show an unlabelled window as the long one than to drop it.
    const {present} = readCodexUsage({
        rate_limit: {primary_window: {used_percent: 10}},
    });

    assert.deepEqual(present, {session: false, weekly: true});
});

test('an empty codex payload reports no windows', () => {
    assert.deepEqual(readCodexUsage({}).present, {session: false, weekly: false});
    assert.deepEqual(readCodexUsage({rate_limit: {}}).present, {session: false, weekly: false});
});

test('two windows of the same class do not overwrite each other', () => {
    const {data} = readCodexUsage({
        rate_limit: {
            primary_window: {limit_window_seconds: FIVE_HOURS, used_percent: 10},
            secondary_window: {limit_window_seconds: FIVE_HOURS, used_percent: 90},
        },
    });

    // First one wins; the second has nowhere sensible to go.
    assert.equal(data.sessionRemainingPct, 90);
});
