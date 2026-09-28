import type { CallingHours } from '@cs/regions';

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Day of week (0 = Sunday) and minutes after midnight for an instant in a time zone. */
export function localParts(at: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = WEEKDAYS[get('weekday')];
  if (weekday === undefined) throw new Error(`Could not read weekday for ${timeZone}`);
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return { weekday, minutes };
}

export function withinCallingHours(at: Date, timeZone: string, hours: CallingHours): boolean {
  const { weekday, minutes } = localParts(at, timeZone);
  const window = weekday === 0 || weekday === 6 ? hours.weekend : hours.weekday;
  return minutes >= window.start && minutes < window.end;
}

export function inSilenceWindow(at: Date, pollCloseAt: Date, hours: number): boolean {
  if (hours <= 0) return false;
  const start = pollCloseAt.getTime() - hours * 3600_000;
  const t = at.getTime();
  return t >= start && t <= pollCloseAt.getTime();
}
