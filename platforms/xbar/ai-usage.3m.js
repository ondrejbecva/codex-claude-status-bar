#!/usr/bin/env node

// <xbar.title>AI usage limits</xbar.title>
// <xbar.version>v1.4.0</xbar.version>
// <xbar.author>Ondřej Bečva</xbar.author>
// <xbar.desc>Claude and Codex rate-limit windows in the macOS menu bar.</xbar.desc>
// <xbar.dependencies>node</xbar.dependencies>
//
// The `3m` in the filename is xbar's refresh interval, matching the poll
// interval the GNOME extension uses. Rename the file to change it.
//
// xbar runs this, reads stdout, and draws it. There is no daemon: one pass,
// print, exit. That makes the poller unnecessary here — the providers are
// called directly and the result rendered.

import {createClaudeProvider} from '../../core/providers/claude.js';
import {createCodexProvider} from '../../core/providers/codex.js';
import {createProviderSlot} from '../../core/provider-slot.js';
import {summarize} from '../../core/summary.js';
import {buildUsageViewModel} from '../../core/view-model.js';
import {createNodeFetch, readTextFile} from '../node/runtime.js';
import {renderFailure, renderPlugin} from './render.js';

// Set to true to show Claude's model-scoped Fable cap as a third row.
const SHOW_FABLE = false;

async function collect() {
    const {fetch} = createNodeFetch();
    const deps = {fetch, readTextFile};

    const providers = [createClaudeProvider(deps), createCodexProvider(deps)];
    const at = new Date().toISOString();

    // Both providers are polled at once; one being unreachable must not hide
    // the other.
    const slots = await Promise.all(providers.map(async provider => {
        const slot = createProviderSlot(provider.name);

        try {
            slot.apply(await provider.getUsage(), 1, at);
        } catch (error) {
            slot.apply(
                {ok: false, error: {code: 'network_error', message: String(error)}},
                1,
                at,
            );
        }

        return slot;
    }));

    return summarize(slots);
}

try {
    const summary = await collect();

    process.stdout.write(`${renderPlugin(buildUsageViewModel(summary, {
        now: Date.now(),
        // Matches the filename, so "next update" tells the truth.
        pollIntervalMs: 180_000,
        showClaudeFable: SHOW_FABLE,
    }))}\n`);
} catch (error) {
    // A crash here would leave the menu bar empty with no explanation.
    process.stdout.write(`${renderFailure(error?.message ?? error)}\n`);
    process.exitCode = 1;
}
