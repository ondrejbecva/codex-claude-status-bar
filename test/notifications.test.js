import {test} from 'node:test';
import assert from 'node:assert/strict';

import {createThresholdNotifier} from '../core/notifications.js';

const RESET_A = '2026-07-27T18:00:00Z';
const RESET_B = '2026-07-27T23:00:00Z';

// A summary carrying one Claude session reading.
function session(remainingPct, resetsAtIso = RESET_A) {
    return {
        providers: {
            claude: {data: {sessionRemainingPct: remainingPct, sessionResetsAtIso: resetsAtIso}},
        },
    };
}

function recorder(options = {}) {
    const sent = [];
    const notifier = createThresholdNotifier({
        notifyFn: (title, body, provider) => sent.push({title, body, provider}),
        ...options,
    });

    return {sent, feed: (...summaries) => summaries.forEach(s => notifier.evaluate(s))};
}

test('the first reading never notifies, having nothing to compare against', () => {
    const {sent, feed} = recorder();

    feed(session(5));

    assert.equal(sent.length, 0);
});

test('crossing below the threshold notifies once, not on every poll', () => {
    const {sent, feed} = recorder();

    feed(session(50), session(15), session(12), session(10));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, 'Claude 5h low');
    assert.equal(sent[0].provider, 'claude');
    assert.match(sent[0].body, /^15% remaining — resets /);
});

test('recovering above the threshold re-arms the warning', () => {
    const {sent, feed} = recorder();

    // The recovery is deliberately small. A larger step up would also be read
    // as a rollover, which is the intended reading of quota reappearing.
    feed(session(50), session(15), session(22), session(15));

    assert.equal(sent.length, 2);
    assert.equal(sent.every(n => n.title === 'Claude 5h low'), true);
});

test('sitting below the threshold from the start stays quiet', () => {
    // Nothing crossed while we were watching.
    const {sent, feed} = recorder();

    feed(session(10), session(9), session(8));

    assert.equal(sent.length, 0);
});

test('a large jump upward is reported as a reset', () => {
    const {sent, feed} = recorder();

    feed(session(40), session(100));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, 'Claude 5h limit reset');
    assert.match(sent[0].body, /^100% available again — next reset /);
});

test('a barely-used window rolling over is still a reset', () => {
    // A 5-point step is under the jump threshold, but landing at full is
    // unmistakable.
    const {sent, feed} = recorder();

    feed(session(95), session(100));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, 'Claude 5h limit reset');
});

test('server-side rounding is not a reset', () => {
    const {sent, feed} = recorder();

    feed(session(72), session(72.4));

    assert.equal(sent.length, 0);
});

test('an untouched window at full does not announce itself forever', () => {
    const {sent, feed} = recorder();

    feed(session(100), session(100), session(100));

    assert.equal(sent.length, 0);
});

test('quota being consumed is never a reset', () => {
    const {sent, feed} = recorder();

    feed(session(100), session(80), session(60));

    assert.equal(sent.length, 0);
});

test('reset notifications can be declined, and the setting is read live', () => {
    let wanted = false;
    const {sent, feed} = recorder({shouldNotifyReset: () => wanted});

    feed(session(40), session(100));
    assert.equal(sent.length, 0);

    // Flipped on without rebuilding the notifier.
    wanted = true;
    feed(session(40), session(100));
    assert.equal(sent.length, 1);
});

test('declining resets does not silence low warnings', () => {
    const {sent, feed} = recorder({shouldNotifyReset: () => false});

    feed(session(50), session(15));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, 'Claude 5h low');
});

test('a full rollover warns, resets, then warns again on the new window', () => {
    const {sent, feed} = recorder();

    feed(
        session(50, RESET_A),
        session(15, RESET_A),
        // The window rolls over: quota back to full under a new reset time.
        session(100, RESET_B),
        session(15, RESET_B),
    );

    assert.deepEqual(sent.map(n => n.title), [
        'Claude 5h low',
        'Claude 5h limit reset',
        'Claude 5h low',
    ]);
});

test('windows and providers are tracked separately', () => {
    const sent = [];
    const notifier = createThresholdNotifier({
        notifyFn: (title, body, provider) => sent.push({title, provider}),
    });

    const summary = (claudeSession, codexWeekly) => ({
        providers: {
            claude: {data: {sessionRemainingPct: claudeSession, sessionResetsAtIso: RESET_A}},
            codex: {data: {weeklyRemainingPct: codexWeekly, weeklyResetsAtIso: RESET_A}},
        },
    });

    notifier.evaluate(summary(50, 50));
    notifier.evaluate(summary(15, 15));

    assert.deepEqual(sent.map(n => n.title).sort(), ['Claude 5h low', 'Codex 7d low']);
    assert.deepEqual(sent.map(n => n.provider).sort(), ['claude', 'codex']);
});

test('a window the provider does not report is ignored', () => {
    const {sent, feed} = recorder();

    // Codex on a plan with no 5h window.
    const summary = weekly => ({
        providers: {
            codex: {data: {sessionRemainingPct: null, weeklyRemainingPct: weekly, weeklyResetsAtIso: RESET_A}},
        },
    });

    feed(summary(50), summary(15));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, 'Codex 7d low');
});

test('a provider with no data at all is skipped', () => {
    const {sent, feed} = recorder();

    feed({providers: {claude: {data: null}}}, {providers: {}}, {}, undefined);

    assert.equal(sent.length, 0);
});

test('a custom threshold is honoured', () => {
    const {sent, feed} = recorder({thresholdPct: 50});

    feed(session(60), session(45));

    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, 'Claude 5h low');
});
