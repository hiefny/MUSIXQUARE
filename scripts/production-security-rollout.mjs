function readAssignment(line, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = line.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`));
  return match?.[1] ?? null;
}

function activeAssignment(text, flag) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const value = readAssignment(line, flag);
    if (value !== null) {
      return String(value)
        .trim()
        .replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

/**
 * Validate the launch-only account-aware PRO contract without consulting
 * process state. Identity and least-privilege authority are unconditional;
 * the only configurable boundary left here is the required D1 binding.
 */
export function validateAccountRolloutConfig(proConfig, appConfig) {
  const errors = [];
  const activeProConfig = proConfig
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  if (
    activeAssignment(proConfig, 'PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION') !== null ||
    activeAssignment(proConfig, 'PRO_ROOM_MEMBER_AUTHORITY_PROJECTION') !== null
  ) {
    errors.push('Retired PRO account projection flags must not be present.');
  }
  if (!/^\s*binding\s*=\s*["']MUSIXQUARE_AUTH_DB["']\s*$/m.test(activeProConfig)) {
    errors.push(
      'PRO room decommissioning is enabled without an active MUSIXQUARE_AUTH_DB Worker binding.',
    );
  }
  const activeAppConfig = appConfig
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  if (!/^\s*binding\s*=\s*["']MUSIXQUARE_AUTH_DB["']\s*$/m.test(activeAppConfig)) {
    errors.push('Account identity is enabled without an active MUSIXQUARE_AUTH_DB App binding.');
  }
  return errors;
}
