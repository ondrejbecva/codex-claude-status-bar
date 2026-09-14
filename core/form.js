// Form encoding for the OAuth token refreshes.
//
// `URLSearchParams` is a Web API. Node and browsers have it; GJS does not, so
// building a refresh body with it throws `ReferenceError: URLSearchParams is
// not defined` inside GNOME Shell. The core targets both runtimes, so it
// encodes the body itself and hands every runtime a plain string.

export function encodeFormBody(fields) {
    return Object.entries(fields)
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
        .join('&');
}
