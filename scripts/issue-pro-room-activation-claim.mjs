import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  issueProRoomActivationClaim,
  issueProRoomOwnerRecoveryClaim,
} from '../cloudflare/pro-room-claims.js';

const SUPPORTED_ROOM_CODES = new Set(['000000']);
const CLAIM_TOKEN_RE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const USAGE = 'Usage: npm run pro-room:issue-claim -- 000000 | --recovery 000000';

export class ProRoomClaimCliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProRoomClaimCliError';
  }
}

export function parseProRoomClaimRoomCode(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || !SUPPORTED_ROOM_CODES.has(argv[0])) {
    throw new ProRoomClaimCliError(USAGE);
  }
  return argv[0];
}

export function parseProRoomClaimRequest(argv) {
  if (Array.isArray(argv) && argv.length === 1) {
    return { mode: 'activation', roomCode: parseProRoomClaimRoomCode(argv) };
  }
  if (
    Array.isArray(argv) &&
    argv.length === 2 &&
    argv[0] === '--recovery' &&
    SUPPORTED_ROOM_CODES.has(argv[1])
  ) {
    return { mode: 'recovery', roomCode: argv[1] };
  }
  throw new ProRoomClaimCliError(USAGE);
}

export function formatProRoomActivationFragment(claimToken) {
  if (typeof claimToken !== 'string' || !CLAIM_TOKEN_RE.test(claimToken)) {
    throw new ProRoomClaimCliError('Activation claim generation failed');
  }
  // A fragment is not sent in HTTP requests. Encoding the opaque credential
  // also prevents it from introducing a second fragment parameter.
  return `#pro-claim=${encodeURIComponent(claimToken)}`;
}

export function formatProRoomOwnerRecoveryFragment(claimToken) {
  if (typeof claimToken !== 'string' || !CLAIM_TOKEN_RE.test(claimToken)) {
    throw new ProRoomClaimCliError('Owner recovery claim generation failed');
  }
  return `#pro-recovery=${encodeURIComponent(claimToken)}`;
}

export async function runProRoomActivationClaimCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  issueClaim = issueProRoomActivationClaim,
  issueRecoveryClaim = issueProRoomOwnerRecoveryClaim,
} = {}) {
  const request = parseProRoomClaimRequest(argv);
  const secret = env.PRO_ROOM_ACTIVATION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new ProRoomClaimCliError(
      'PRO_ROOM_ACTIVATION_SECRET must be supplied through the environment',
    );
  }

  let claimToken;
  try {
    claimToken =
      request.mode === 'recovery'
        ? await issueRecoveryClaim(request.roomCode, secret)
        : await issueClaim(request.roomCode, secret);
  } catch {
    // Do not forward implementation errors: they can accidentally contain
    // secret-bearing input supplied by an operator.
    throw new ProRoomClaimCliError(
      request.mode === 'recovery'
        ? 'Owner recovery claim generation failed'
        : 'Activation claim generation failed',
    );
  }
  const fragment =
    request.mode === 'recovery'
      ? formatProRoomOwnerRecoveryFragment(claimToken)
      : formatProRoomActivationFragment(claimToken);
  stdout.write(`${fragment}\n`);
  return fragment;
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isDirectInvocation()) {
  try {
    await runProRoomActivationClaimCli();
  } catch (error) {
    const message =
      error instanceof ProRoomClaimCliError ? error.message : 'PRO room claim generation failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
