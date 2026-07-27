import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    countdown,
    nextUpdateLabel,
    quotaTier,
    remainingLabel,
    resetMoment,
    resetsInLabel,
} from '../core/format.js';

const NOW = Date.parse('2026-07-27T12:00:00Z');
const inMinutes = n => new Date(NOW + n * 60_000).toISOString();

test('quota tiers sit on their boundaries', () => {
    assert.equal(quotaTier(100), 'green');
    assert.equal(quotaTier(70), 'green');
    assert.equal(quotaTier(69.9), 'yellow');
    assert.equal(quotaTier(30), 'yellow');
    assert.equal(quotaTier(29.9), 'red');
    assert.equal(quotaTier(0), 'red');
});

test('an unknown percentage reads as red rather than as nothing', () => {
    assert.equal(quotaTier(null), 'red');
    assert.equal(quotaTier(undefined), 'red');
    assert.equal(quotaTier(Number.NaN), 'red');
});

test('countdowns drop the units that would read as zero', () => {
    assert.equal(countdown(inMinutes(49), NOW), '49m');
    assert.equal(countdown(inMinutes(60), NOW), '1h');
    assert.equal(countdown(inMinutes(289), NOW), '4h 49m');
    assert.equal(countdown(inMinutes(1440), NOW), '1d');
    assert.equal(countdown(inMinutes(10079), NOW), '6d 23h 59m');
});

test('a moment already past has no countdown', () => {
    assert.equal(countdown(inMinutes(-1), NOW), '--');
    assert.equal(countdown(inMinutes(0), NOW), '--');
});

test('a missing or unparseable timestamp has no countdown', () => {
    assert.equal(countdown(null, NOW), '--');
    assert.equal(countdown('not a date', NOW), '--');
});

test('reset moments are phrased the way someone would say them', () => {
    const local = (day, hour, minute) => new Date(2026, 6, day, hour, minute).toISOString();
    const noon27 = new Date(2026, 6, 27, 12, 0).getTime();

    assert.equal(resetMoment(local(27, 16, 20), noon27), 'today 16:20');
    assert.equal(resetMoment(local(28, 9, 5), noon27), 'tomorrow 09:05');
    // Within the week, a weekday name is unambiguous.
    assert.equal(resetMoment(local(30, 9, 5), noon27), 'Thu 09:05');
    // Past it, it is not.
    assert.equal(resetMoment(local(3 + 31, 14, 0), noon27), '3 Aug 14:00');
});

test('a reset moment in the past still renders', () => {
    const noon27 = new Date(2026, 6, 27, 12, 0).getTime();

    assert.equal(resetMoment(new Date(2026, 6, 26, 8, 0).toISOString(), noon27), '26 Jul 08:00');
});

test('a missing reset moment renders as unknown', () => {
    assert.equal(resetMoment(null), '--');
    assert.equal(resetMoment('nonsense'), '--');
});

test('remaining is rounded and labelled', () => {
    assert.equal(remainingLabel(93.4), '93% left');
    assert.equal(remainingLabel(0), '0% left');
    assert.equal(remainingLabel(null), '-- left');
});

test('resets-in reads as a sentence, or not at all', () => {
    assert.equal(resetsInLabel(inMinutes(289), NOW), 'Resets in 4h 49m');
    assert.equal(resetsInLabel(null, NOW), '--');
});

test('the next update is rounded up so it never reads as due when it is not', () => {
    const last = '2026-07-27T12:00:00Z';

    assert.equal(nextUpdateLabel(last, 180_000, NOW), 'Next update in 3m');
    // 30 seconds away is 1m, not 0m.
    assert.equal(nextUpdateLabel(last, 180_000, NOW + 150_000), 'Next update in 1m');
    assert.equal(nextUpdateLabel(last, 180_000, NOW + 180_000), 'Next update in 0m');
    assert.equal(nextUpdateLabel(last, 180_000, NOW + 999_000), 'Next update in 0m');
});

test('the next update is unknown until something has been polled', () => {
    assert.equal(nextUpdateLabel(null, 180_000, NOW), 'Next update in --');
    assert.equal(nextUpdateLabel('2026-07-27T12:00:00Z', null, NOW), 'Next update in --');
});
