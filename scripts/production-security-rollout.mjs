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

/**
 * Validate the production Remote Share authority and abuse-control rollout.
 * The assertion may move from optional to required after the documented
 * cached-client observation gate, but production must never silently disable
 * it or the room-wide atomic allocation budget.
 */
export function validateRemoteShareRolloutConfig(remoteShareConfig, signalingConfig) {
  const errors = [];
  const mode = activeAssignment(remoteShareConfig, 'ROOM_UPLOAD_ASSERTION_MODE');
  if (mode !== 'optional' && mode !== 'required') {
    errors.push('ROOM_UPLOAD_ASSERTION_MODE must be optional or required in production.');
  }

  const rawRoomLimit = activeAssignment(remoteShareConfig, 'ROOM_UPLOADS_PER_WINDOW');
  const roomLimit = rawRoomLimit === null ? Number.NaN : Number(rawRoomLimit);
  if (!Number.isSafeInteger(roomLimit) || roomLimit < 1 || roomLimit > 1024) {
    errors.push('ROOM_UPLOADS_PER_WINDOW must be an integer from 1 through 1024.');
  }

  const activeRemoteShareConfig = remoteShareConfig
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  if (!/^\s*binding\s*=\s*["']MUSIXQUARE_ADMIN_DB["']\s*$/m.test(activeRemoteShareConfig)) {
    errors.push('Remote Share assertion rollout requires the MUSIXQUARE_ADMIN_DB binding.');
  }
  const versionMetadataSection =
    activeRemoteShareConfig.match(/\[version_metadata\]([\s\S]*?)(?=\n\s*\[|$)/u)?.[1] ?? '';
  if (!/^\s*binding\s*=\s*["']CF_VERSION_METADATA["']\s*$/m.test(versionMetadataSection)) {
    errors.push('Remote Share release approval requires the CF_VERSION_METADATA binding.');
  }

  const secretName = 'MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET';
  if (!remoteShareConfig.includes(secretName) || !signalingConfig.includes(secretName)) {
    errors.push('Remote Share and signaling must both declare the shared assertion secret name.');
  }
  return errors;
}
