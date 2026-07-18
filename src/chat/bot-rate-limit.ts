const UNIT_LOCALES: Record<string, string> = {
  'pt-br': 'pt-BR',
  'zh-hans': 'zh-Hans',
  'zh-hant': 'zh-Hant',
};

function formatUnit(value: number, unit: 'hour' | 'minute' | 'second', locale: string): string {
  const resolvedLocale = UNIT_LOCALES[locale.toLowerCase()] ?? locale;
  try {
    return new Intl.NumberFormat(resolvedLocale, {
      style: 'unit',
      unit,
      unitDisplay: 'long',
      useGrouping: false,
    }).format(value);
  } catch {
    const suffix = unit === 'hour' ? 'h' : unit === 'minute' ? 'm' : 's';
    return `${value}${suffix}`;
  }
}

/** Format a bounded Retry-After value without exposing raw multi-thousand seconds. */
export function formatBotRetryDuration(totalSeconds: number, locale: string): string {
  const seconds = Math.max(1, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(formatUnit(hours, 'hour', locale));
  if (hours > 0 || minutes > 0) parts.push(formatUnit(minutes, 'minute', locale));
  parts.push(formatUnit(remainingSeconds, 'second', locale));
  return parts.join(' ');
}
