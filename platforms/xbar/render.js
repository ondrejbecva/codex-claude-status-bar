// Renders a view model as an xbar / SwiftBar plugin document.
//
// The format is plain text: the first line is what appears in the macOS menu
// bar, `---` starts the dropdown, and `| key=value` trailers style a line or
// attach behaviour to it.
//
// Kept separate from the plugin entry point so it can be tested without a Mac.

// Same palette the GNOME panel uses, so the two look like one product.
const COLOURS = {
    green: '#a6e3a1',
    yellow: '#f9e2af',
    red: '#f38ba8',
};

const DIM = '#8a8a8a';

// Short names for the menu bar, where width is scarce.
const BAR_LABELS = {
    Session: '5h',
    Weekly: '7d',
    Fable: 'F',
};

function hasReading(window) {
    return !window.remainingText.startsWith('--');
}

// One provider's contribution to the menu bar: "Claude 5h 28% / 7d 91%".
// Windows the provider does not report are dropped rather than shown empty.
function barSegment(service) {
    const parts = service.windows
        .filter(hasReading)
        .map(window => `${BAR_LABELS[window.label] ?? window.label} ${window.remainingPct}%`);

    return parts.length > 0 ? `${service.name} ${parts.join(' / ')}` : null;
}

function menuBarLine(services) {
    const segments = services.map(barSegment).filter(Boolean);

    // xbar shows the plugin name when a plugin prints nothing, which looks
    // like a bug rather than an absence of data.
    return segments.length > 0 ? segments.join('  |  ') : 'AI usage --';
}

function styled(text, params = {}) {
    const trailer = Object.entries(params)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');

    return trailer ? `${text} | ${trailer}` : text;
}

export function renderPlugin(viewModel, options = {}) {
    const lines = [menuBarLine(viewModel.services), '---'];

    for (const service of viewModel.services) {
        lines.push(styled(service.name, {size: 13}));

        if (service.warning)
            lines.push(styled(`  ${service.warning}`, {color: COLOURS.red, size: 12}));

        for (const window of service.windows) {
            const detail = hasReading(window)
                ? `${window.remainingText} · ${window.resetsInText}`
                : 'no data';

            lines.push(styled(`  ${window.label}  ${detail}`, {
                color: COLOURS[window.dotColor] ?? DIM,
                font: 'Menlo',
                size: 12,
            }));
        }

        lines.push('---');
    }

    lines.push(styled(viewModel.lastUpdate, {size: 11, color: DIM}));
    lines.push(styled(viewModel.version, {size: 11, color: DIM}));
    lines.push(styled('Refresh', {refresh: 'true'}));

    if (options.trailer)
        lines.push(options.trailer);

    return lines.join('\n');
}

// Shown when the plugin itself fails, so the bar says something actionable
// instead of going blank.
export function renderFailure(message) {
    return [
        'AI usage ⚠',
        '---',
        styled(String(message).split('\n')[0], {color: COLOURS.red, font: 'Menlo', size: 12}),
        styled('Refresh', {refresh: 'true'}),
    ].join('\n');
}
