import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Calendars, CalendarError } from '../src/sources/calendar.ts';

const ICS = [
  'BEGIN:VCALENDAR', 'X-WR-CALNAME:Home',
  'BEGIN:VEVENT', 'UID:1', 'SUMMARY:Dentist', 'DTSTART:20261016T090000Z', 'DTEND:20261016T093000Z', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

/** A fake fetch that answers from a queue of responses (or throws for null). */
function fakeFetch(answers: (Response | null)[]): typeof fetch {
  return (async () => {
    const next = answers.shift();
    if (!next) throw new Error('offline');
    return next;
  }) as typeof fetch;
}

test('fetches a webcal:// calendar and names it from the file', async () => {
  const urls: string[] = [];
  const calendars = new Calendars(['webcal://example.com/private.ics'], {
    fetchFn: (async (url: string) => { urls.push(url); return new Response(ICS); }) as unknown as typeof fetch,
  });
  const result = await calendars.refresh();
  assert.deepEqual(urls, ['https://example.com/private.ics']);
  assert.match(result.summary, /^Home · 1 event/);
  const { occurrences } = calendars.between('2026-10-16', '2026-10-16', 'UTC');
  assert.equal(occurrences[0].title, 'Dentist');
  assert.equal(occurrences[0].calendar, 'Home');
});

test('5.3 — one calendar failing is a failure, but its last good copy stays', async () => {
  const calendars = new Calendars(['https://example.com/a.ics', 'https://example.com/b.ics'], {
    fetchFn: fakeFetch([new Response(ICS), new Response(ICS), null, new Response(ICS)]),
    now: () => new Date('2026-10-14T10:00:00Z'),
  });
  await calendars.refresh();
  await assert.rejects(calendars.refresh(), /offline.*Still showing the copy from 2026-10-14 10:00/);
  assert.equal(calendars.between('2026-10-16', '2026-10-16', 'UTC').occurrences.length, 2);
});

test('every calendar failing is an error; a web page instead of a calendar is explained', async () => {
  const calendars = new Calendars(['https://example.com/page'], { fetchFn: fakeFetch([new Response('<html>')]) });
  await assert.rejects(calendars.refresh(), (error: Error) => error instanceof CalendarError && /iCal format/.test(error.message));
  const refused = new Calendars(['https://example.com/old.ics'], { fetchFn: fakeFetch([new Response('', { status: 404 })]) });
  await assert.rejects(refused.refresh(), /reset/);
});

test('the secret address never appears in names or messages', async () => {
  const calendars = new Calendars(['https://example.com/secret-token-123.ics'], { fetchFn: fakeFetch([null]) });
  await assert.rejects(calendars.refresh(), (error: Error) => !error.message.includes('secret-token-123'));
  assert.deepEqual(calendars.names(), ['Calendar']);
});
