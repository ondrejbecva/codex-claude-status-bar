import {test} from 'node:test';
import assert from 'node:assert/strict';

import {buildUsageViewModel} from '../core/view-model.js';
import {renderFailure, renderPlugin} from '../platforms/xbar/render.js';

const NOW = Date.parse('2026-07-27T12:00:00Z');

const SUMMARY = {
    lastUpdatedAtIso: '2026-07-27T11:59:00Z',
    providers: {
        claude: {
            code: 'OK',
            data: {
                sessionRemainingPct: 28,
                weeklyRemainingPct: 91,
                sessionResetsAtIso: '2026-07-27T16:49:00Z',
                weeklyResetsAtIso: '2026-08-03T07:59:00Z',
            },
        },
        codex: {
            code: 'OK',
            data: {weeklyRemainingPct: 86, weeklyResetsAtIso: '2026-08-03T14:38:00Z'},
        },
    },
};

const render = (summary, options) =>
    renderPlugin(buildUsageViewModel(summary, {now: NOW, ...options}));

const menuBar = output => output.split('\n')[0];

test('the menu bar line carries both providers', () => {
    assert.equal(menuBar(render(SUMMARY)), 'Codex 7d 86%  |  Claude 5h 28% / 7d 91%');
});

test('a window the provider does not report is left out of the menu bar', () => {
    // Codex has no 5h window here, so the bar must not show an empty one.
    assert.equal(menuBar(render(SUMMARY)).includes('Codex 5h'), false);
});

test('the menu bar never renders empty', () => {
    // xbar falls back to the plugin filename when a plugin prints nothing,
    // which reads as a crash.
    assert.equal(menuBar(render(null)), 'AI usage --');
    assert.equal(menuBar(render({providers: {}})), 'AI usage --');
});

test('the dropdown separates the menu bar from the detail', () => {
    const lines = render(SUMMARY).split('\n');

    assert.equal(lines[1], '---');
});

test('each window becomes a coloured detail row', () => {
    const output = render(SUMMARY);

    assert.match(output, /Session {2}28% left · Resets in 4h 49m \| color=#f38ba8 font=Menlo size=12/);
    assert.match(output, /Weekly {2}91% left · Resets in 6d 19h 59m \| color=#a6e3a1 font=Menlo size=12/);
});

test('quota bands pick the colour', () => {
    const at = pct => render({providers: {claude: {code: 'OK', data: {sessionRemainingPct: pct}}}});

    assert.match(at(90), /Session.*color=#a6e3a1/);
    assert.match(at(50), /Session.*color=#f9e2af/);
    assert.match(at(10), /Session.*color=#f38ba8/);
});

test('a window with no reading says so rather than showing a blank', () => {
    assert.match(render(SUMMARY), /Session {2}no data/);
});

test('a provider warning is surfaced in the dropdown', () => {
    const output = render({providers: {claude: {code: 'AUTH_EXPIRED', data: null}}});

    assert.match(output, /Claude: authentication expired \| color=#f38ba8/);
});

test('the fable row follows the toggle', () => {
    assert.equal(render(SUMMARY).includes('Fable'), false);

    const withFable = render(
        {providers: {claude: {code: 'OK', data: {fableRemainingPct: 100}}}},
        {showClaudeFable: true},
    );

    assert.match(withFable, /Fable {2}100% left/);
    // And it is abbreviated in the menu bar.
    assert.match(menuBar(withFable), /Claude F 100%/);
});

test('the footer carries the poll countdown, the version and a refresh action', () => {
    const lines = render(SUMMARY, {pollIntervalMs: 180_000}).split('\n');

    assert.match(lines.at(-3), /^Next update in 2m \| size=11/);
    assert.match(lines.at(-2), /^codex-claude-status-bar .* \| size=11/);
    assert.equal(lines.at(-1), 'Refresh | refresh=true');
});

test('a failure renders something actionable instead of a blank bar', () => {
    const output = renderFailure('spawn node ENOENT\nstack line that should not appear');

    assert.equal(menuBar(output), 'AI usage ⚠');
    assert.match(output, /spawn node ENOENT \| color=#f38ba8/);
    assert.equal(output.includes('stack line'), false);
    assert.match(output, /Refresh \| refresh=true/);
});
