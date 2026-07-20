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
 * Validate the atomic account-aware PRO rollout contract without consulting
 * process state. Keeping this portion pure lets CI exercise every flag/binding
 * combination while the executable guard remains the production entry point.
 */
export function validateAccountRolloutConfig(proConfig, appConfig) {
  const errors = [];
  const accountIdentityProjection = activeAssignment(
    proConfig,
    'PRO_ROOM_ACCOUNT_IDENTITY_PROJECTION',
  );
  const memberAuthorityProjection = activeAssignment(
    proConfig,
    'PRO_ROOM_MEMBER_AUTHORITY_PROJECTION',
  );
  const projectionValues = [accountIdentityProjection, memberAuthorityProjection];

  if (projectionValues.some((value) => value !== '0' && value !== '1')) {
    errors.push('Both PRO account projection flags must be explicitly set to "0" or "1".');
    return errors;
  }
  if (accountIdentityProjection !== memberAuthorityProjection) {
    errors.push('PRO account identity and member authority projections must change together.');
    return errors;
  }
  if (accountIdentityProjection !== '1') return errors;

  const activeAppConfig = appConfig
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  if (!/^\s*binding\s*=\s*["']MUSIXQUARE_AUTH_DB["']\s*$/m.test(activeAppConfig)) {
    errors.push(
      'PRO account projection is enabled without an active MUSIXQUARE_AUTH_DB App binding.',
    );
  }
  return errors;
}
