/** Parse an explicit ISO instant without Date's impossible-day normalization. */
export function parseAnnouncementExpiry(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return null;
  const match = text.match(
    /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', , zone = ''] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59 ||
    (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  ) {
    return undefined;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
