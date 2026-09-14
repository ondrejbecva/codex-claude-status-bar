// Form encoding for the OAuth token refreshes.
//
// `URLSearchParams` is a Web API. Node and browsers have it; GJS does not, so
// building a refresh body with it throws `ReferenceError: URLSearchParams is
// not defined` inside GNOME Shell. Encode the body here and hand libsoup a
// plain string.

export function encodeFormBody(fields) {
    return Object.entries(fields)
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
        .join('&');
}
