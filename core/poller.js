// Drives every provider on a fixed interval and publishes a combined summary.
//
// Platform-free: timers and the clock are injected, so the same poller runs
// under GLib in a GNOME extension and under Node in a menu-bar script.

import {createRetryPacer} from './retry.js';
import {createProviderSlot} from './provider-slot.js';
import {summarize} from './summary.js';

export const DEFAULT_POLL_INTERVAL_MS = 180_000;

// Providers may be given as {claude: provider} or as [provider] carrying its
// own name.
function toEntries(providers) {
    if (Array.isArray(providers))
        return providers.map((provider, i) => [provider?.name ?? `provider_${i}`, provider]);

    if (providers && typeof providers === 'object')
        return Object.entries(providers);

    return [];
}

function thrownAsFailure() {
    return {
        ok: false,
        error: {
            code: 'network_error',
            message: 'Provider threw instead of returning a result',
        },
    };
}

export function createPoller(options = {}) {
    const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const nowIso = options.nowIso ?? (() => new Date().toISOString());
    const setTimer = options.setIntervalFn ?? globalThis.setInterval;
    const clearTimer = options.clearIntervalFn ?? globalThis.clearInterval;
    const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;
    const pacer = options.retryPacer ?? createRetryPacer();

    const slots = new Map();
    const sources = new Map();
    // Per provider: the tail of its request chain, so two polls of the same
    // provider never overlap. Providers do not wait on each other.
    const chains = new Map();
    // Per provider: monotonic request ids, used to discard overtaken results.
    const issued = new Map();

    for (const [name, provider] of toEntries(options.providers)) {
        slots.set(name, createProviderSlot(name));
        sources.set(name, provider);
        chains.set(name, Promise.resolve());
        issued.set(name, 0);
    }

    let timerId = null;

    function publish() {
        onUpdate?.(summarize(slots.values()));
    }

    function poll(name) {
        const slot = slots.get(name);
        const provider = sources.get(name);

        if (!slot || typeof provider?.getUsage !== 'function')
            return Promise.resolve();

        if (pacer.isPaused(name))
            return Promise.resolve();

        const requestId = issued.get(name) + 1;
        issued.set(name, requestId);

        const chain = chains.get(name).then(async () => {
            slot.inFlight = true;
            publish();

            let result;
            try {
                result = await provider.getUsage();
            } catch {
                result = thrownAsFailure();
            }

            slot.apply(result, requestId, nowIso());
            pacer.record(name, result);
            slot.inFlight = false;
            publish();
        });

        chains.set(name, chain);
        return chain;
    }

    async function refresh() {
        await Promise.all([...slots.keys()].map(poll));
        return summarize(slots.values());
    }

    return {
        start() {
            if (timerId)
                return;

            timerId = setTimer(() => void refresh(), intervalMs);
            void refresh();
        },

        stop() {
            if (!timerId)
                return;

            clearTimer(timerId);
            timerId = null;
        },

        refresh,

        getSummary() {
            return summarize(slots.values());
        },
    };
}
