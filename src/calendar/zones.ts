// Time zones, without a library (Phase 4). See docs/DECISIONS.md, D11.
//
// A calendar event says "09:00 in Europe/London" or "14:00 UTC". To put it on
// this app's timeline we need the instant that means, then the wall-clock
// time that instant is *here*. JavaScript's built-in `Intl` knows every time
// zone's rules (including clock changes), so both directions are done by
// asking it what the clock reads in a zone at a given instant.

/** A wall-clock date and time, with no zone attached. Months are 1–12. */
export interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** The time zone this computer is set to, e.g. "Europe/Dublin". */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** What the clock reads in `zone` at instant `ms`. */
export function wallAt(ms: number, zone: string): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour, mi: parts.minute, s: parts.second };
}

/** The instant at which the clock in `zone` reads `wall`.
 *
 *  Works by guessing, seeing how far off the zone's clock is, and correcting
 *  — twice, so a guess that lands across a clock change still settles. In
 *  the hour that doesn't exist (01:30 on the night clocks go forward) it
 *  lands an hour later, which is what calendar apps do too. */
export function instantOf(wall: Wall, zone: string): number {
  const asIfUtc = Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s);
  if (zone === 'UTC') return asIfUtc;
  let guess = asIfUtc - offsetAt(asIfUtc, zone);
  guess = asIfUtc - offsetAt(guess, zone);
  return guess;
}

/** How far ahead of UTC the clock in `zone` is at instant `ms`, in ms. */
function offsetAt(ms: number, zone: string): number {
  const w = wallAt(ms, zone);
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - wholeSecond;
}

// ---- Naming zones ------------------------------------------------------------

/**
 * Outlook and Exchange name zones the Windows way ("GMT Standard Time")
 * rather than the standard way ("Europe/London"). These are the common
 * ones; anything else unknown is read as this computer's own zone, and the
 * sync says so. Source: the Unicode CLDR Windows-zones table.
 */
const WINDOWS_ZONES: Record<string, string> = {
  'GMT Standard Time': 'Europe/London', // Dublin, Edinburgh, Lisbon, London
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

/** A usable zone name for a calendar's TZID, or null if we can't tell. */
export function resolveZone(tzid: string): string | null {
  const name = tzid.replace(/^"|"$/g, '').trim();
  if (!name) return null;
  if (/^(utc|gmt|z|etc\/utc|etc\/gmt)$/i.test(name)) return 'UTC';
  const candidate = WINDOWS_ZONES[name] ?? name;
  try {
    formatterFor(candidate);
    return candidate;
  } catch {
    return null; // not a zone Intl knows
  }
}
