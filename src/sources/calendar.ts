// Your calendar (backlog 4.1). See docs/DECISIONS.md, D11.
//
// Lunatask's API has no calendar, and Lunatask's calendar is your Google,
// Outlook or iCloud calendar shown inside it anyway — so this reads that
// calendar directly, from its private iCalendar (.ics) address. Each entry in
// CALENDAR_URLS is one calendar: an https:// or webcal:// address, or the
// path of an .ics file on this computer.
//
// Read-only, like every source (D8): this only ever downloads.
//
// Events are NOT tasks, so they never go into tasks.json. They're held in
// memory, refreshed with the other sources (every 15 minutes, and on "Sync
// now"), and expanded into the days the page asks for.
//
// If a calendar can't be fetched, the last copy that worked is kept, and the
// sync counts as failed (5.3) with a message saying how old that copy is —
// a calendar that quietly stops updating is worse than one that says it has.

import { readFile } from 'node:fs/promises';
import { occurrences, parseCalendar, type Occurrence, type ParsedCalendar } from '../calendar/ics.ts';

export class CalendarError extends Error {}

/** One occurrence of an event, labelled with which calendar it's from. */
export interface CalendarOccurrence extends Occurrence {
  calendar: string;
}

interface Feed {
  /** The address or path. Kept private: a calendar's .ics address is a
   *  password — anyone with it can read your calendar — so it's never sent
   *  to the page or written in a message. */
  location: string;
  /** What to call it until the file names itself. */
  fallbackName: string;
  parsed: ParsedCalendar | null;
  fetchedAt: string | null;
}

export interface CalendarOptions {
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export class Calendars {
  private readonly feeds: Feed[];
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(locations: string[], options: CalendarOptions = {}) {
    this.feeds = locations.map((location, i) => ({
      location,
      fallbackName: locations.length === 1 ? 'Calendar' : `Calendar ${i + 1}`,
      parsed: null,
      fetchedAt: null,
    }));
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  get configured(): boolean {
    return this.feeds.length > 0;
  }

  /** The calendars' names, as far as we know them yet. */
  names(): string[] {
    return this.feeds.map(nameOf);
  }

  /**
   * Fetch every calendar again. One failing doesn't stop the others being
   * fetched, but if any fails it throws afterwards (5.3), so the failure
   * shows as an error, not a footnote. The others are updated either way.
   */
  async refresh(): Promise<{ summary: string; warnings: string[] }> {
    const warnings: string[] = [];
    let failed = 0;
    let events = 0;

    for (const feed of this.feeds) {
      try {
        const parsed = parseCalendar(await this.download(feed.location));
        feed.parsed = parsed;
        feed.fetchedAt = this.now().toISOString();
        events += parsed.events.length;
        if (parsed.skipped) warnings.push(`${nameOf(feed)}: ${parsed.skipped} event${parsed.skipped === 1 ? '' : 's'} couldn't be read and ${parsed.skipped === 1 ? 'is' : 'are'} missing.`);
        if (parsed.unknownZones.length) {
          warnings.push(`${nameOf(feed)}: didn't recognise the time zone ${parsed.unknownZones.map((z) => `"${z}"`).join(', ')} — those times are shown as if they were in this computer's zone.`);
        }
      } catch (error) {
        failed++;
        const stale = feed.fetchedAt ? ` Still showing the copy from ${feed.fetchedAt.slice(0, 16).replace('T', ' ')} (UTC).` : '';
        warnings.push(`${nameOf(feed)}: ${(error as Error).message}${stale}`);
      }
    }

    if (failed > 0) throw new CalendarError(warnings.join(' '));
    const names = this.names().join(', ');
    return { summary: `${names} · ${events} event${events === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`, warnings };
  }

  /** Every occurrence overlapping `from`…`to` (inclusive), from every
   *  calendar, in time order. Floating times are read in `zone`. */
  between(from: string, to: string, zone: string): { occurrences: CalendarOccurrence[]; unsupportedRules: number } {
    const all: CalendarOccurrence[] = [];
    let unsupportedRules = 0;
    for (const feed of this.feeds) {
      if (!feed.parsed) continue;
      const expansion = occurrences(feed.parsed, from, to, zone);
      unsupportedRules += expansion.unsupportedRules;
      for (const o of expansion.occurrences) all.push({ ...o, calendar: nameOf(feed) });
    }
    all.sort((a, b) => (a.startMs ?? Date.parse(`${a.startDate}T00:00:00Z`)) - (b.startMs ?? Date.parse(`${b.startDate}T00:00:00Z`)));
    return { occurrences: all, unsupportedRules };
  }

  private async download(location: string): Promise<string> {
    if (!/^(https?|webcal):\/\//i.test(location)) {
      try {
        return await readFile(location, 'utf8');
      } catch (error) {
        throw new CalendarError(`couldn't read the file (${(error as NodeJS.ErrnoException).code ?? 'error'}).`);
      }
    }

    // webcal:// is just "https://, but open it in a calendar app".
    const url = location.replace(/^webcal:\/\//i, 'https://');
    let response: Response;
    try {
      response = await this.fetchFn(url, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new CalendarError(`couldn't be reached (${(error as Error).message}). Are you online?`);
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new CalendarError(`the calendar address was refused (${response.status}). It may have been reset — copy the private address again into CALENDAR_URLS.`);
    }
    if (!response.ok) throw new CalendarError(`answered ${response.status} ${response.statusText}.`);
    const text = await response.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      throw new CalendarError('that address didn\'t return a calendar. Use the private "iCal format" address, not the calendar\'s web page.');
    }
    return text;
  }
}

function nameOf(feed: Feed): string {
  return feed.parsed?.name || feed.fallbackName;
}
