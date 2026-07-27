// Every string the UI shows is built here, so the popup, the top bar and the
// notifications phrase the same fact the same way.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const NO_VALUE = '--';

function toEpochMs(iso) {
    if (!iso)
        return null;

    const ms = new Date(iso).getTime();

    return Number.isNaN(ms) ? null : ms;
}

function twoDigits(value) {
    return String(value).padStart(2, '0');
}

// Quota bands the colours key off. Deliberately the only place the numbers
// appear.
export function quotaTier(remainingPct) {
    if (!Number.isFinite(remainingPct))
        return 'red';

    if (remainingPct >= 70)
        return 'green';

    if (remainingPct >= 30)
        return 'yellow';

    return 'red';
}

// How long until a moment, coarsely: "6d 23h", "4h 49m", "3m". Units that
// would read as zero are dropped, except when everything is zero and "0m" is
// the honest answer.
export function countdown(iso, now) {
    const target = toEpochMs(iso);

    if (target === null || target <= now)
        return NO_VALUE;

    const minutes = Math.floor((target - now) / MINUTE_MS);
    const parts = [
        [Math.floor(minutes / 1440), 'd'],
        [Math.floor(minutes % 1440 / 60), 'h'],
        [minutes % 60, 'm'],
    ].filter(([value]) => value > 0);

    if (parts.length === 0)
        return '0m';

    return parts.map(([value, unit]) => `${value}${unit}`).join(' ');
}

// A moment in local time, phrased the way someone would say it out loud:
// "today 16:20", "tomorrow 09:05", "Thu 09:05", "3 Aug 14:00". Used where an
// absolute time reads better than a countdown — notifications outlive the
// moment they were written.
export function resetMoment(iso, now = Date.now()) {
    const ms = toEpochMs(iso);

    if (ms === null)
        return NO_VALUE;

    const at = new Date(ms);
    const clock = `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;

    const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const daysAway = Math.round((startOfDay(at) - startOfDay(new Date(now))) / DAY_MS);

    if (daysAway === 0)
        return `today ${clock}`;

    if (daysAway === 1)
        return `tomorrow ${clock}`;

    // Inside the coming week a weekday name is unambiguous; past that it is
    // not, so fall back to a date.
    if (daysAway > 1 && daysAway < 7)
        return `${WEEKDAYS[at.getDay()]} ${clock}`;

    return `${at.getDate()} ${MONTHS[at.getMonth()]} ${clock}`;
}

export function remainingLabel(remainingPct) {
    if (!Number.isFinite(remainingPct))
        return `${NO_VALUE} left`;

    return `${Math.round(remainingPct)}% left`;
}

export function resetsInLabel(iso, now) {
    const relative = countdown(iso, now);

    return relative === NO_VALUE ? NO_VALUE : `Resets in ${relative}`;
}

// When the next poll is due, given when the last one landed.
export function nextUpdateLabel(lastUpdatedAtIso, pollIntervalMs, now) {
    const last = toEpochMs(lastUpdatedAtIso);

    if (last === null || !Number.isFinite(pollIntervalMs))
        return `Next update in ${NO_VALUE}`;

    const dueIn = last + pollIntervalMs - now;

    if (dueIn <= 0)
        return 'Next update in 0m';

    // Round up, so a poll 30 seconds away reads as 1m rather than 0m.
    return `Next update in ${Math.max(1, Math.ceil(dueIn / MINUTE_MS))}m`;
}
