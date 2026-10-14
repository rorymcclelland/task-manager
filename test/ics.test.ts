import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, parseCalendar } from '../src/calendar/ics.ts';
import { instantOf, resolveZone, wallAt } from '../src/calendar/zones.ts';

/** Wrap VEVENT lines in a calendar. */
function cal(...events: string[][]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Work', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
}

/** Occurrences between two days, as readable strings: "Title @ ISO" or "Title @ date..date". */
function list(text: string, from: string, to: string): string[] {
  return occurrences(parseCalendar(text), from, to, 'Europe/Dublin').occurrences.map((o) =>
    o.allDay ? `${o.title} @ ${o.startDate}..${o.endDate}` : `${o.title} @ ${new Date(o.startMs!).toISOString().slice(0, 16)}`,
  );
}

test('the calendar names itself, and text is unescaped and unfolded', () => {
  const text = cal(['UID:1', 'SUMMARY:Budget\\, Q4 \\; review', 'LOCATION:Room 2', 'DTSTART:20261016T090000Z', 'DTEND:20261016T100000Z', 'DESCRIPTION:a very long', '  line']);
  const parsed = parseCalendar(text);
  assert.equal(parsed.name, 'Work');
  assert.equal(parsed.events[0].title, 'Budget, Q4 ; review');
  assert.equal(parsed.events[0].location, 'Room 2');
  const folded = cal(['UID:1', 'SUMMARY:Long tit', ' le here', 'DTSTART:20261016T090000Z']);
  assert.equal(parseCalendar(folded).events[0].title, 'Long title here');
});

test('UTC, zoned and all-day times', () => {
  const text = cal(
    ['UID:1', 'SUMMARY:UTC', 'DTSTART:20261016T090000Z', 'DTEND:20261016T100000Z'],
    ['UID:2', 'SUMMARY:Taipei', 'DTSTART;TZID=Asia/Taipei:20261016T090000', 'DURATION:PT30M'],
    ['UID:3', 'SUMMARY:Off', 'DTSTART;VALUE=DATE:20261016', 'DTEND;VALUE=DATE:20261018'],
  );
  // All-day first, then in time order.
  assert.deepEqual(list(text, '2026-10-16', '2026-10-16'), [
    'Off @ 2026-10-16..2026-10-18',
    'Taipei @ 2026-10-16T01:00',
    'UTC @ 2026-10-16T09:00',
  ]);
});

test('Outlook\'s Windows zone names are understood; unknown ones are reported', () => {
  assert.equal(resolveZone('GMT Standard Time'), 'Europe/London');
  assert.equal(resolveZone('"Europe/Dublin"'), 'Europe/Dublin');
  assert.equal(resolveZone('Somewhere Odd'), null);
  const parsed = parseCalendar(cal(['UID:1', 'SUMMARY:x', 'DTSTART;TZID=Somewhere Odd:20261016T090000']));
  assert.deepEqual(parsed.unknownZones, ['Somewhere Odd']);
});

test('zone maths survives the clocks going back', () => {
  // 25 Oct 2026: Irish clocks go back from 02:00 IST to 01:00 GMT.
  assert.equal(new Date(instantOf({ y: 2026, m: 10, d: 24, h: 9, mi: 0, s: 0 }, 'Europe/Dublin')).toISOString(), '2026-10-24T08:00:00.000Z');
  assert.equal(new Date(instantOf({ y: 2026, m: 10, d: 26, h: 9, mi: 0, s: 0 }, 'Europe/Dublin')).toISOString(), '2026-10-26T09:00:00.000Z');
  assert.deepEqual(wallAt(Date.parse('2026-10-26T09:00:00Z'), 'Asia/Taipei'), { y: 2026, m: 10, d: 26, h: 17, mi: 0, s: 0 });
});

test('a weekly meeting keeps its local time across the clock change', () => {
  const text = cal(['UID:1', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/London:20261005T093000', 'DTEND;TZID=Europe/London:20261005T094500', 'RRULE:FREQ=WEEKLY;BYDAY=MO']);
  assert.deepEqual(list(text, '2026-10-19', '2026-10-27'), ['Standup @ 2026-10-19T08:30', 'Standup @ 2026-10-26T09:30']);
});

test('weekly on several days, every other week, with a count', () => {
  const text = cal(['UID:1', 'SUMMARY:Gym', 'DTSTART:20261006T070000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=4']);
  assert.deepEqual(list(text, '2026-10-01', '2026-12-31'), [
    'Gym @ 2026-10-06T07:00',
    'Gym @ 2026-10-08T07:00',
    'Gym @ 2026-10-20T07:00',
    'Gym @ 2026-10-22T07:00',
  ]);
});

test('UNTIL ends a rule; EXDATE skips one', () => {
  const text = cal(['UID:1', 'SUMMARY:Daily', 'DTSTART:20261012T080000Z', 'RRULE:FREQ=DAILY;UNTIL=20261015T080000Z', 'EXDATE:20261013T080000Z']);
  assert.deepEqual(list(text, '2026-10-01', '2026-10-31'), ['Daily @ 2026-10-12T08:00', 'Daily @ 2026-10-14T08:00', 'Daily @ 2026-10-15T08:00']);
});

test('weekdays only: daily with BYDAY', () => {
  const text = cal(['UID:1', 'SUMMARY:Check-in', 'DTSTART:20261016T080000Z', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR']);
  assert.deepEqual(list(text, '2026-10-16', '2026-10-19'), ['Check-in @ 2026-10-16T08:00', 'Check-in @ 2026-10-19T08:00']);
});

test('monthly: the last Friday, and the 31st (skipping short months)', () => {
  const lastFriday = cal(['UID:1', 'SUMMARY:Review', 'DTSTART:20260130T150000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR']);
  assert.deepEqual(list(lastFriday, '2026-10-01', '2026-11-30'), ['Review @ 2026-10-30T15:00', 'Review @ 2026-11-27T15:00']);
  const the31st = cal(['UID:2', 'SUMMARY:Invoice', 'DTSTART;VALUE=DATE:20260831', 'RRULE:FREQ=MONTHLY']);
  assert.deepEqual(list(the31st, '2026-09-01', '2026-11-01'), ['Invoice @ 2026-10-31..2026-11-01']);
});

test('yearly all-day events, such as birthdays', () => {
  const text = cal(['UID:1', 'SUMMARY:Birthday', 'DTSTART;VALUE=DATE:19900314', 'RRULE:FREQ=YEARLY', 'TRANSP:TRANSPARENT']);
  const parsed = parseCalendar(text);
  assert.equal(parsed.events[0].busy, false);
  assert.deepEqual(list(text, '2027-03-01', '2027-03-31'), ['Birthday @ 2027-03-14..2027-03-15']);
});

test('one occurrence moved, another cancelled', () => {
  const text = cal(
    ['UID:s', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/Dublin:20261026T093000', 'RRULE:FREQ=DAILY;COUNT=3'],
    ['UID:s', 'RECURRENCE-ID;TZID=Europe/Dublin:20261027T093000', 'SUMMARY:Standup (late)', 'DTSTART;TZID=Europe/Dublin:20261027T110000'],
    ['UID:s', 'RECURRENCE-ID:20261028T093000Z', 'STATUS:CANCELLED', 'DTSTART:20261028T093000Z'],
  );
  assert.deepEqual(list(text, '2026-10-26', '2026-10-30'), ['Standup @ 2026-10-26T09:30', 'Standup (late) @ 2026-10-27T11:00']);
});

test('reminders inside an event don\'t overwrite its details', () => {
  const text = cal(['UID:1', 'SUMMARY:Dentist', 'DTSTART:20261016T090000Z', 'BEGIN:VALARM', 'SUMMARY:Reminder', 'TRIGGER:-PT15M', 'END:VALARM']);
  assert.equal(parseCalendar(text).events[0].title, 'Dentist');
});

test('a rule we can\'t read shows the first occurrence and is counted', () => {
  const text = cal(['UID:1', 'SUMMARY:Odd', 'DTSTART:20261016T090000Z', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=2']);
  const result = occurrences(parseCalendar(text), '2026-10-01', '2026-12-31', 'UTC');
  assert.equal(result.occurrences.length, 1);
  assert.equal(result.unsupportedRules, 1);
});

test('a broken event is skipped, not fatal', () => {
  const parsed = parseCalendar(cal(['UID:1', 'SUMMARY:No start']));
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.skipped, 1);
});

test('an endless daily rule from long ago still answers quickly', () => {
  const text = cal(['UID:1', 'SUMMARY:Forever', 'DTSTART:20000101T080000Z', 'RRULE:FREQ=DAILY']);
  const started = performance.now();
  assert.equal(list(text, '2026-10-14', '2026-10-27').length, 14);
  assert.ok(performance.now() - started < 1000);
});
