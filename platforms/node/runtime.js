// Node runtime shims — used by the macOS menu-bar script, the planned Windows
// tray app, and anything else that runs the core outside GNOME Shell.
//
// Node 18+ ships a global fetch that already matches what the core expects, so
// there is nothing to adapt; only the home-relative path handling is ours.

import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';

export function createNodeFetch() {
    if (typeof globalThis.fetch !== 'function')
        throw new Error('This runtime has no global fetch; Node 18 or newer is required');

    return {
        fetch: (url, options) => globalThis.fetch(url, options),
        // Nothing to tear down — kept so callers can treat both runtimes alike.
        dispose() {},
    };
}

export async function readTextFile(path) {
    if (typeof path !== 'string' || path === '')
        throw new Error('readTextFile needs a non-empty path');

    const absolute = path.startsWith('~/')
        ? `${homedir()}${path.slice(1)}`
        : path;

    return readFile(absolute, 'utf8');
}
