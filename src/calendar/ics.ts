// Reading calendars in iCalendar (.ics) format (backlog 4.1). See
// docs/DECISIONS.md, D11.
//
// Google Calendar, Outlook and iCloud can all publish a calendar as a
// private .ics address, so this one format covers all of them. The file is
// plain text: blocks of BEGIN:VEVENT … END:VEVENT, one property per line.
//
// Two jobs, both pure (no network, no clock):
//
//   parseCalendar(text)        → the events in the file, as written
//   occurrences(cal, from, to) → every time they happen between two days,
//                                with repeating events expanded
//
// What's understood: one-off and all-day events, time zones (standard and
// Windows names), repeating events (daily, weekly, monthly, yearly — with
// intervals, counts, end dates, "every Tuesday and Thursday", "the last
// Friday of the month"), skipped dates, single occurrences moved or
// cancelled, and "show me as free".
//
// What isn't: the rarer repeat rules (e.g. "the 2nd weekday of the month",
// hourly). An event using one shows only its first occurrence, and the
// sync's warnings say how many did — so a gap in the calendar is never
// silent.

import { instantOf, resolveZone, type Wall } from './zones.ts';

// ---- What a parsed calendar looks like ----------------------------------------

/** A date and time as the file wrote it. */
export type IcsTime =
  | { kind: 'date'; date: string } //                          all-day: 20261016
  | { kind: 'time'; wall: Wall; zone: string | null }; //       zone null = "floating": read as this computer's zone

export interface IcsEvent {
  uid: string;
  title: string;
  location: string;
  start: IcsTime;
  /** Length: whole days for all-day events, otherwise milliseconds. */
  length: { days: number } | { ms: number };
  /** False for events marked "show me as free" (TRANSP:TRANSPARENT) —
   *  they're shown but don't eat into free time. */
  busy: boolean;
  rule: RepeatRule | null;
  /** The rule was there but uses parts we can't read. */
  ruleUnsupported: boolean;
  /** Occurrences skipped (EXDATE), as occurrence keys — see `keyOf`. */
  skip: Set<string>;
  /** Set when this event replaces one occurrence of a repeating event. */
  replaces: string | null;
  cancelled: boolean;
}

export interface RepeatRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  /** Last allowed start: an instant (ms) for timed events, a date for all-day. */
  until: { ms: number } | { date: string } | null;
  /** e.g. [{wd: 1}] = Mondays; [{n: -1, wd: 5}] = the last Friday. 0 = Sunday. */
  byDay: { n: number | null; wd: number }[];
  byMonthDay: number[];
  byMonth: number[];
}

export interface ParsedCalendar {
  /** From X-WR-CALNAME, when the file names itself. */
  name: string | null;
  events: IcsEvent[];
  /** Events that couldn't be read at all. */
  skipped: number;
  /** TZIDs we didn't recognise (read as this computer's zone instead). */
  unknownZones: string[];
}

// ---- Parsing --------------------------------------------------------------------

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

export function parseCalendar(text: string): ParsedCalendar {
  const result: ParsedCalendar = { name: null, events: [], skipped: 0, unknownZones: [] };
  const unknownZones = new Set<string>();

  // Lines longer than 75 characters are folded: continued on the next line,
  // which starts with a space or tab. Undo that first.
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);

  // Which BEGIN…END blocks we're inside. Only properties directly inside a
  // VEVENT belong to it — a VALARM (reminder) inside it has its own.
  const stack: string[] = [];
  let current: Property[] | null = null;

  for (const line of lines) {
    if (!line) continue;
    const prop = parseLine(line);
    if (!prop) continue;

    if (prop.name === 'BEGIN') {
      stack.push(prop.value.toUpperCase());
      if (prop.value.toUpperCase() === 'VEVENT') current = [];
      continue;
    }
    if (prop.name === 'END') {
      const ended = stack.pop();
      if (ended === 'VEVENT' && current) {
        try {
          result.events.push(toEvent(current, unknownZones));
        } catch {
          result.skipped++;
        }
        current = null;
      }
      continue;
    }

    const inside = stack[stack.length - 1];
    if (inside === 'VEVENT' && current) current.push(prop);
    else if (inside === 'VCALENDAR' && prop.name === 'X-WR-CALNAME') result.name = unescapeText(prop.value);
  }

  result.unknownZones = [...unknownZones];
  return result;
}

/** NAME;PARAM=x;PARAM2="y":value  →  {name, params, value} */
function parseLine(line: string): Property | null {
  // The value starts after the first colon that isn't inside quotes.
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;
  const [name, ...paramParts] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function toEvent(props: Property[], unknownZones: Set<string>): IcsEvent {
  const get = (name: string) => props.find((p) => p.name === name);
  const all = (name: string) => props.filter((p) => p.name === name);

  const startProp = get('DTSTART');
  if (!startProp) throw new Error('No start');
  const start = parseTime(startProp, unknownZones);

  // Length: from DTEND, or DURATION, or the iCalendar defaults (an all-day
  // event with neither lasts one day; a timed one is a moment).
  let length: IcsEvent['length'];
  const endProp = get('DTEND');
  const durationProp = get('DURATION');
  if (start.kind === 'date') {
    const end = endProp ? parseTime(endProp, unknownZones) : null;
    const days = end
      ? daysBetweenDates(start.date, end.kind === 'date' ? end.date : wallDate(end.wall))
      : durationProp
        ? Math.round(parseDuration(durationProp.value) / 86_400_000)
        : 1;
    length = { days: Math.max(1, days) };
  } else {
    const ms = endProp
      ? toMs(parseTime(endProp, unknownZones)) - toMs(start)
      : durationProp
        ? parseDuration(durationProp.value)
        : 0;
    length = { ms: Math.max(0, ms) };
  }

  const ruleProp = get('RRULE');
  let rule: RepeatRule | null = null;
  let ruleUnsupported = false;
  if (ruleProp) {
    rule = parseRule(ruleProp.value, start, unknownZones);
    if (!rule) ruleUnsupported = true;
  }

  const skip = new Set<string>();
  for (const prop of all('EXDATE')) {
    // One EXDATE line can list several, comma-separated, sharing its params.
    for (const value of prop.value.split(',')) {
      skip.add(keyOf(parseTime({ ...prop, value }, unknownZones)));
    }
  }

  const replacesProp = get('RECURRENCE-ID');
  return {
    uid: get('UID')?.value ?? '',
    title: unescapeText(get('SUMMARY')?.value ?? '') || '(no title)',
    location: unescapeText(get('LOCATION')?.value ?? ''),
    start,
    length,
    busy: (get('TRANSP')?.value ?? '').toUpperCase() !== 'TRANSPARENT',
    rule,
    ruleUnsupported,
    skip,
    replaces: replacesProp ? keyOf(parseTime(replacesProp, unknownZones)) : null,
    cancelled: (get('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED',
  };
}

/** 20261016 · 20261016T090000 · 20261016T090000Z, with TZID / VALUE=DATE params. */
function parseTime(prop: Property, unknownZones: Set<string>): IcsTime {
  const match = prop.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) throw new Error(`Unreadable date: ${prop.value}`);
  const [, y, m, d, h, mi, s, z] = match;
  if (h === undefined || prop.params.VALUE === 'DATE') {
    return { kind: 'date', date: `${y}-${m}-${d}` };
  }
  let zone: string | null = null;
  if (z) zone = 'UTC';
  else if (prop.params.TZID) {
    zone = resolveZone(prop.params.TZID);
    if (!zone) unknownZones.add(prop.params.TZID);
  }
  return { kind: 'time', wall: { y: +y, m: +m, d: +d, h: +h, mi: +mi, s: +(s ?? 0) }, zone };
}

/** P1D · PT1H30M · P1W · -PT15M → milliseconds. */
function parseDuration(value: string): number {
  const match = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) throw new Error(`Unreadable duration: ${value}`);
  const [, sign, w, d, h, m, s] = match;
  const ms = (((+(w ?? 0) * 7 + +(d ?? 0)) * 24 + +(h ?? 0)) * 60 + +(m ?? 0)) * 60_000 + +(s ?? 0) * 1000;
  return sign === '-' ? -ms : ms;
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
/** Rule parts we follow. Anything else (BYSETPOS, BYHOUR…) means we can't. */
const UNDERSTOOD = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);

/** FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261231T235959Z → RepeatRule, or
 *  null if it uses something we don't understand. */
function parseRule(value: string, start: IcsTime, unknownZones: Set<string>): RepeatRule | null {
  const parts: Record<string, string> = {};
  for (const piece of value.split(';')) {
    const [key, val] = piece.split('=');
    if (key) parts[key.toUpperCase()] = (val ?? '').toUpperCase();
  }
  if (Object.keys(parts).some((key) => !UNDERSTOOD.has(key))) return null;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(parts.FREQ)) return null;

  const byDay: RepeatRule['byDay'] = [];
  for (const item of (parts.BYDAY ?? '').split(',').filter(Boolean)) {
    const match = item.match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!match) return null;
    byDay.push({ n: match[1] ? Number(match[1]) : null, wd: WEEKDAYS[match[2]] });
  }
  // "The 2nd Tuesday" only makes sense within a month or year.
  if (byDay.some((b) => b.n !== null) && !['MONTHLY', 'YEARLY'].includes(parts.FREQ)) return null;
  // "Every Tuesday of the year" — legal but rare; not worth the code.
  if (parts.FREQ === 'YEARLY' && byDay.length && !parts.BYMONTH) return null;

  const numbers = (text: string | undefined) => (text ?? '').split(',').filter(Boolean).map(Number);
  const byMonthDay = numbers(parts.BYMONTHDAY);
  const byMonth = numbers(parts.BYMONTH);
  if ([...byMonthDay, ...byMonth].some((n) => !Number.isInteger(n))) return null;

  let until: RepeatRule['until'] = null;
  if (parts.UNTIL) {
    const time = parseTime({ name: 'UNTIL', params: {}, value: parts.UNTIL }, unknownZones);
    if (start.kind === 'date') until = { date: time.kind === 'date' ? time.date : wallDate(time.wall) };
    else if (time.kind === 'date') until = { ms: Date.parse(`${time.date}T23:59:59Z`) };
    else until = { ms: toMs({ ...time, zone: time.zone ?? start.zone }) };
  }

  const interval = Number(parts.INTERVAL ?? 1);
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  if (!Number.isInteger(interval) || interval < 1 || (count !== null && !(count >= 1))) return null;

  return { freq: parts.FREQ as RepeatRule['freq'], interval, count, until, byDay, byMonthDay, byMonth };
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch)).trim();
}

// ---- Expanding into occurrences ---------------------------------------------------

/** One time an event happens. */
export interface Occurrence {
  uid: string;
  title: string;
  location: string;
  busy: boolean;
  allDay: boolean;
  /** All-day: first day and the day after the last (YYYY-MM-DD). */
  startDate: string | null;
  endDate: string | null;
  /** Timed: instants in ms. */
  startMs: number | null;
  endMs: number | null;
}

export interface Expansion {
  occurrences: Occurrence[];
  /** Repeating events we could only show the first time of. */
  unsupportedRules: number;
}

/** Hard stop on how far a rule is followed, so a malformed or very old
 *  "every day forever" can't hang the app. ~55 years of daily events. */
const MAX_STEPS = 20_000;

/**
 * Every occurrence that overlaps the days `from`…`to` (inclusive,
 * YYYY-MM-DD). `zone` is the zone floating times are read in — this
 * computer's, normally.
 */
export function occurrences(calendar: ParsedCalendar, from: string, to: string, zone: string): Expansion {
  const out: Occurrence[] = [];
  let unsupportedRules = 0;

  // The window's edges as instants: midnight at the start of `from` and at
  // the end of `to`, in the zone the days are being shown in.
  const midnight = (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    return instantOf({ y, m, d, h: 0, mi: 0, s: 0 }, zone);
  };
  const windowStart = midnight(from);
  const windowEnd = midnight(addDays(to, 1));
  const overlaps = (o: Occurrence) =>
    o.allDay
      ? o.endDate! > from && o.startDate! <= to
      : o.endMs! > o.startMs!
        ? o.startMs! < windowEnd && o.endMs! > windowStart
        : o.startMs! >= windowStart && o.startMs! < windowEnd;

  // Occurrences that have been moved or cancelled individually, per event.
  const replaced = new Map<string, Set<string>>();
  for (const event of calendar.events) {
    if (event.replaces) {
      if (!replaced.has(event.uid)) replaced.set(event.uid, new Set());
      replaced.get(event.uid)!.add(event.replaces);
    }
  }

  for (const event of calendar.events) {
    if (event.cancelled) continue; // a cancelled one-off, or a cancelled occurrence

    const starts: IcsTime[] = [];
    if (event.rule && !event.replaces) {
      const skip = new Set([...event.skip, ...(replaced.get(event.uid) ?? [])]);
      for (const start of expandRule(event, event.rule, windowEnd, zone)) {
        if (!skip.has(keyOf(start))) starts.push(start);
      }
    } else {
      if (event.ruleUnsupported) unsupportedRules++;
      starts.push(event.start);
    }

    for (const start of starts) {
      const occurrence = occurrenceAt(event, start, zone);
      if (overlaps(occurrence)) out.push(occurrence);
    }
  }

  out.sort((a, b) => sortKey(a) - sortKey(b));
  return { occurrences: out, unsupportedRules };
}

function occurrenceAt(event: IcsEvent, start: IcsTime, zone: string): Occurrence {
  const base = { uid: event.uid, title: event.title, location: event.location, busy: event.busy };
  if (start.kind === 'date') {
    const days = 'days' in event.length ? event.length.days : 1;
    return { ...base, allDay: true, startDate: start.date, endDate: addDays(start.date, days), startMs: null, endMs: null };
  }
  const startMs = toMs(start, zone);
  const ms = 'ms' in event.length ? event.length.ms : 0;
  return { ...base, allDay: false, startDate: null, endDate: null, startMs, endMs: startMs + ms };
}

/**
 * The start of every occurrence of a repeating event, in order, until the
 * rule ends or we pass `windowEnd`.
 *
 * Works in the event's own wall-clock time — "09:00 every Monday" stays
 * 09:00 across a clock change, which is what the person who set it up meant.
 */
function* expandRule(event: IcsEvent, rule: RepeatRule, windowEnd: number, zone: string): Generator<IcsTime> {
  const start = event.start;
  const first = start.kind === 'date' ? start.date : wallDate(start.wall);
  let produced = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const dates = candidateDates(rule, first, step);
    if (dates === null) return; // ran out of calendar
    for (const date of dates) {
      if (date < first) continue; // a rule never goes back before the first one
      const time: IcsTime = start.kind === 'date' ? { kind: 'date', date } : { kind: 'time', wall: withDate(start.wall, date), zone: start.zone };

      if (rule.until) {
        // (Floating times are compared as UTC on both sides — see parseRule.)
        const tooLate = 'date' in rule.until ? date > rule.until.date : toMs(time) > rule.until.ms;
        if (tooLate) return;
      }
      if (rule.count !== null && produced >= rule.count) return;
      produced++;

      if ((time.kind === 'date' ? Date.parse(`${date}T00:00:00Z`) : toMs(time, zone)) > windowEnd) return;
      yield time;
    }
  }
}

/** The dates in the `step`th period of the rule (the `step`th day, week,
 *  month or year after the first), in order. */
function candidateDates(rule: RepeatRule, first: string, step: number): string[] | null {
  const [fy, fm, fd] = first.split('-').map(Number);
  const n = step * rule.interval;
  const keep = (date: string) => {
    const [, m, d] = date.split('-').map(Number);
    if (rule.byMonth.length && !rule.byMonth.includes(m)) return false;
    if (rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') {
      if (rule.byMonthDay.length && !rule.byMonthDay.includes(d)) return false;
      if (rule.byDay.length && !rule.byDay.some((b) => b.wd === weekday(date))) return false;
    }
    return true;
  };

  switch (rule.freq) {
    case 'DAILY':
      return [addDays(first, n)].filter(keep);
    case 'WEEKLY': {
      // Weeks run Monday–Sunday (iCalendar's default).
      const monday = addDays(first, -((weekday(first) + 6) % 7) + n * 7);
      const days = rule.byDay.length ? rule.byDay.map((b) => b.wd) : [weekday(first)];
      return [...new Set(days)]
        .map((wd) => addDays(monday, (wd + 6) % 7))
        .sort()
        .filter((date) => !rule.byMonth.length || rule.byMonth.includes(Number(date.slice(5, 7))));
    }
    case 'MONTHLY': {
      const index = fm - 1 + n;
      const y = fy + Math.floor(index / 12);
      if (y > 9999) return null;
      return datesInMonth(rule, y, (index % 12) + 1, fd).filter(keep);
    }
    case 'YEARLY': {
      const y = fy + n;
      if (y > 9999) return null;
      const months = rule.byMonth.length ? rule.byMonth : [fm];
      return months.flatMap((m) => datesInMonth(rule, y, m, fd)).sort();
    }
  }
}

/** Which days of one month a monthly/yearly rule picks. */
function datesInMonth(rule: RepeatRule, y: number, m: number, firstDay: number): string[] {
  const length = daysInMonth(y, m);
  const date = (d: number) => `${y}-${pad(m)}-${pad(d)}`;
  let days: number[];

  if (rule.byDay.length) {
    days = [];
    for (const { n, wd } of rule.byDay) {
      const matching: number[] = [];
      for (let d = 1; d <= length; d++) if (weekday(date(d)) === wd) matching.push(d);
      if (n === null) days.push(...matching);
      else {
        const picked = n > 0 ? matching[n - 1] : matching[matching.length + n];
        if (picked) days.push(picked);
      }
    }
    if (rule.byMonthDay.length) days = days.filter((d) => rule.byMonthDay.some((md) => (md > 0 ? md : length + md + 1) === d));
  } else if (rule.byMonthDay.length) {
    days = rule.byMonthDay.map((md) => (md > 0 ? md : length + md + 1));
  } else {
    days = [firstDay]; // "monthly on the 31st" skips months without one
  }

  return [...new Set(days)].filter((d) => d >= 1 && d <= length).sort((a, b) => a - b).map(date);
}

// ---- Small date helpers -------------------------------------------------------------

/** How occurrences are matched against EXDATE / RECURRENCE-ID: the date for
 *  all-day events, the instant for timed ones (so a skipped date written in
 *  UTC still matches an occurrence written in Europe/London). */
export function keyOf(time: IcsTime): string {
  return time.kind === 'date' ? time.date : String(toMs(time));
}

function toMs(time: IcsTime, floatingZone = 'UTC'): number {
  if (time.kind === 'date') return Date.parse(`${time.date}T00:00:00Z`);
  return instantOf(time.wall, time.zone ?? floatingZone);
}

function sortKey(o: Occurrence): number {
  return o.allDay ? Date.parse(`${o.startDate}T00:00:00Z`) - 1 : o.startMs!;
}

function wallDate(w: Wall): string {
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

function withDate(w: Wall, date: string): Wall {
  const [y, m, d] = date.split('-').map(Number);
  return { ...w, y, m, d };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetweenDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
