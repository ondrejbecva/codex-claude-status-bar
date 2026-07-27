#!/usr/bin/env node

// Prints current usage on stdout. Runs anywhere Node does.
//
// This is the seam every non-GNOME shell can build on: a Windows tray app, a
// shell prompt segment, a cron job, a Raycast script. `--json` emits the raw
// summary so a caller does its own presentation; without it, a compact human
// readable block.
//
//   node platforms/cli/usage.js
//   node platforms/cli/usage.js --json

import {createClaudeProvider} from '../../core/providers/claude.js';
import {createCodexProvider} from '../../core/providers/codex.js';
import {createProviderSlot} from '../../core/provider-slot.js';
import {summarize} from '../../core/summary.js';
import {buildUsageViewModel} from '../../core/view-model.js';
import {createNodeFetch, readTextFile} from '../node/runtime.js';

const asJson = process.argv.includes('--json');
const showFable = process.argv.includes('--fable');

async function collect() {
    const {fetch} = createNodeFetch();
    const deps = {fetch, readTextFile};
    const at = new Date().toISOString();

    const slots = await Promise.all(
        [createClaudeProvider(deps), createCodexProvider(deps)].map(async provider => {
            const slot = createProviderSlot(provider.name);

            try {
                slot.apply(await provider.getUsage(), 1, at);
            } catch (error) {
                slot.apply({ok: false, error: {code: 'network_error', message: String(error)}}, 1, at);
            }

            return slot;
        }),
    );

    return summarize(slots);
}

function toText(summary) {
    const viewModel = buildUsageViewModel(summary, {now: Date.now(), showClaudeFable: showFable});
    const lines = [];

    for (const service of viewModel.services) {
        lines.push(service.name);

        if (service.warning)
            lines.push(`  ! ${service.warning}`);

        for (const window of service.windows) {
            const detail = window.remainingText.startsWith('--')
                ? 'no data'
                : `${window.remainingText.padEnd(9)} ${window.resetsInText}`;

            lines.push(`  ${window.label.padEnd(8)} ${detail}`);
        }

        lines.push('');
    }

    lines.push(viewModel.lastUpdate);

    return lines.join('\n');
}

const summary = await collect();

process.stdout.write(asJson
    ? `${JSON.stringify(summary, null, 2)}\n`
    : `${toText(summary)}\n`);

// A non-zero exit lets a caller tell "everything failed" from "here are the
// numbers", without parsing the output.
const anyUsable = Object.values(summary.providers).some(state => state.code === 'OK');
if (!anyUsable)
    process.exitCode = 1;
