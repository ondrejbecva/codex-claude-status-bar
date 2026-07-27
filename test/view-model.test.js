import {test} from 'node:test';
import assert from 'node:assert/strict';

import {buildUsageViewModel} from '../core/view-model.js';

const NOW = Date.parse('2026-07-27T12:00:00Z');

const SUMMARY = {
    lastUpdatedAtIso: '2026-07-27T11:59:00Z',
    providers: {
        claude: {
            code: 'OK',
            data: {
                sessionRemainingPct: 93.4,
                weeklyRemainingPct: 95,
                sessionResetsAtIso: '2026-07-27T16:49:00Z',
                fableRemainingPct: 100,
                fableResetsAtIso: null,
            },
        },
        codex: {
            code: 'OK',
            data: {weeklyRemainingPct: 100, weeklyResetsAtIso: '2026-08-03T11:59:00Z'},
        },
    },
};

const serviceNamed = (vm, key) => vm.services.find(s => s.key === key);

test('services come out in popup order and are identified by key', () => {
    const vm = buildUsageViewModel(SUMMARY, {now: NOW});

    assert.deepEqual(vm.services.map(s => s.key), ['codex', 'claude']);
    assert.deepEqual(vm.services.map(s => s.name), ['Codex', 'Claude']);
});

test('window figures are rounded and phrased for display', () => {
    const claude = serviceNamed(buildUsageViewModel(SUMMARY, {now: NOW}), 'claude');
    const [session] = claude.windows;

    assert.equal(session.label, 'Session');
    assert.equal(session.remainingPct, 93);
    assert.equal(session.remainingText, '93% left');
    assert.equal(session.resetsInText, 'Resets in 4h 49m');
    assert.equal(session.dotColor, 'green');
});

test('a window the provider does not report still occupies its row', () => {
    const codex = serviceNamed(buildUsageViewModel(SUMMARY, {now: NOW}), 'codex');
    const [session] = codex.windows;

    assert.equal(session.remainingPct, 0);
    assert.equal(session.remainingText, '-- left');
    assert.equal(session.resetsInText, '--');
    assert.equal(session.dotColor, 'red');
});

test('the fable row appears only when it is switched on', () => {
    const off = serviceNamed(buildUsageViewModel(SUMMARY, {now: NOW}), 'claude');
    assert.deepEqual(off.windows.map(w => w.label), ['Session', 'Weekly']);

    const on = serviceNamed(buildUsageViewModel(SUMMARY, {now: NOW, showClaudeFable: true}), 'claude');
    assert.deepEqual(on.windows.map(w => w.label), ['Session', 'Weekly', 'Fable']);
    assert.equal(on.windows[2].remainingText, '100% left');
});

test('codex never grows a fable row', () => {
    const codex = serviceNamed(buildUsageViewModel(SUMMARY, {now: NOW, showClaudeFable: true}), 'codex');

    assert.deepEqual(codex.windows.map(w => w.label), ['Session', 'Weekly']);
});

test('a healthy provider carries no warning', () => {
    const vm = buildUsageViewModel(SUMMARY, {now: NOW});

    assert.equal(serviceNamed(vm, 'claude').warning, '');
});

test('state codes become readable warnings naming the provider', () => {
    const cases = [
        ['AUTH_EXPIRED', 'Claude: authentication expired'],
        ['PARTIAL_DATA', 'Claude: partial usage data'],
        ['NETWORK_ERROR', 'Claude: network error'],
        ['SCHEMA_CHANGED', 'Claude: schema changed'],
    ];

    for (const [code, expected] of cases) {
        const vm = buildUsageViewModel({providers: {claude: {code, data: null}}}, {now: NOW});
        assert.equal(serviceNamed(vm, 'claude').warning, expected, code);
    }
});

test('OK and unknown codes produce no warning text', () => {
    for (const code of ['OK', 'RATE_LIMITED', undefined]) {
        const vm = buildUsageViewModel({providers: {claude: {code, data: null}}}, {now: NOW});
        assert.equal(serviceNamed(vm, 'claude').warning, '', String(code));
    }
});

test('an empty summary still produces a drawable view model', () => {
    for (const summary of [null, undefined, {}, {providers: {}}]) {
        const vm = buildUsageViewModel(summary, {now: NOW});

        assert.equal(vm.services.length, 2);
        assert.equal(vm.services[0].windows.length, 2);
        assert.equal(vm.services[0].windows[0].remainingText, '-- left');
        assert.equal(vm.lastUpdate, 'Next update in --');
    }
});

test('the footer reports when the next poll is due', () => {
    const vm = buildUsageViewModel(SUMMARY, {now: NOW, pollIntervalMs: 180_000});

    assert.equal(vm.lastUpdate, 'Next update in 2m');
});

test('the version string is carried through and overridable', () => {
    assert.match(buildUsageViewModel(SUMMARY, {now: NOW}).version, /^codex-claude-status-bar /);
    assert.equal(buildUsageViewModel(SUMMARY, {now: NOW, version: 'test 9.9'}).version, 'test 9.9');
});
