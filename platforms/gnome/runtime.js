// GNOME Shell runtime shims.
//
// The core asks for two capabilities — send an HTTP request, read a text file
// — and this supplies them with libsoup and Gio. Nothing here knows what the
// core does with them.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function headerPairs(headers) {
    if (!headers || typeof headers !== 'object')
        return [];

    return Object.entries(headers).map(([name, value]) => [name, String(value)]);
}

function contentTypeOf(headers) {
    const match = headerPairs(headers).find(([name]) => name.toLowerCase() === 'content-type');

    return match?.[1] ?? 'application/octet-stream';
}

// Accepts what the core actually sends: a string, URLSearchParams from the
// token refreshes, or raw bytes.
function bodyBytes(body) {
    if (body === undefined || body === null)
        return null;

    if (body instanceof Uint8Array)
        return new GLib.Bytes(body);

    const text = body instanceof URLSearchParams ? body.toString() : String(body);

    return new GLib.Bytes(encoder.encode(text));
}

// Enough of the WHATWG Response surface for the core: ok, status, text, json.
// The body is decoded at most once however many times it is asked for.
function asResponse(status, bytes) {
    let decoded;

    const text = () => {
        decoded ??= decoder.decode(bytes.toArray());
        return decoded;
    };

    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return text();
        },
        async json() {
            return JSON.parse(text());
        },
    };
}

export function createGnomeFetch() {
    const session = new Soup.Session();

    async function fetch(url, options = {}) {
        const message = Soup.Message.new(options.method ?? 'GET', url);

        if (!message)
            throw new Error(`Could not build a request for ${url}`);

        for (const [name, value] of headerPairs(options.headers))
            message.request_headers.append(name, value);

        const payload = bodyBytes(options.body);
        if (payload)
            message.set_request_body_from_bytes(contentTypeOf(options.headers), payload);

        const bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (self, result) => {
                try {
                    resolve(self.send_and_read_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });

        return asResponse(message.get_status(), bytes);
    }

    // Called from the extension's disable(); without it, in-flight requests
    // outlive the extension and land on a disposed callback.
    function dispose() {
        session.abort();
    }

    return {fetch, dispose};
}

export async function readTextFile(path) {
    if (typeof path !== 'string' || path === '')
        throw new Error('readTextFile needs a non-empty path');

    const absolute = path.startsWith('~/')
        ? `${GLib.get_home_dir()}${path.slice(1)}`
        : path;

    const file = Gio.File.new_for_path(absolute);

    const contents = await new Promise((resolve, reject) => {
        file.load_contents_async(null, (self, result) => {
            try {
                const [ok, bytes] = self.load_contents_finish(result);

                if (ok)
                    resolve(bytes);
                else
                    reject(new Error(`Could not read ${absolute}`));
            } catch (error) {
                reject(error);
            }
        });
    });

    return decoder.decode(contents);
}
