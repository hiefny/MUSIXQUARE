/** Device-local compatibility messaging for risky AudioBuffer decodes. */

import { announceSystemMessageLocally } from '../chat/protocol.ts';
import { LOCAL_LARGE_TRACK_WARNING_BYTES } from '../core/constants.ts';
import { bus } from '../core/events.ts';
import { getRoomContext } from '../rooms/authority.ts';
import type { QueueItemId } from '../types/index.ts';
import { evaluateDecodeMemoryWarning, type DecodeMemoryEstimate } from './decode-admission.ts';

const warnedQueueItems = new Set<QueueItemId>();

function announceOnce(
  queueItemId: QueueItemId,
  i18nKey: 'chat.decode_memory_risk_system_message' | 'chat.large_local_track_system_message',
  params?: Record<string, string | number>,
): boolean {
  if (warnedQueueItems.has(queueItemId)) return false;
  warnedQueueItems.add(queueItemId);
  if (params) announceSystemMessageLocally(i18nKey, params);
  else announceSystemMessageLocally(i18nKey);
  return true;
}

/** Local-only advisory derived from decoded PCM and projected decode peak. */
export function maybeAnnounceDecodeMemoryRiskWarning(
  queueItemId: QueueItemId,
  estimate: DecodeMemoryEstimate,
): boolean {
  const evaluation = evaluateDecodeMemoryWarning(estimate);
  if (!evaluation) return false;
  return announceOnce(queueItemId, 'chat.decode_memory_risk_system_message', {
    estimatedMiB: evaluation.estimatedMiB,
  });
}

export function maybeAnnounceLargeLocalTrackWarning(
  queueItemId: QueueItemId,
  encodedBytes: unknown,
): boolean {
  if (
    getRoomContext().kind !== 'standard' ||
    !Number.isSafeInteger(encodedBytes) ||
    (encodedBytes as number) <= LOCAL_LARGE_TRACK_WARNING_BYTES
  ) {
    return false;
  }

  return announceOnce(queueItemId, 'chat.large_local_track_system_message');
}

function resetLargeLocalTrackWarnings(): void {
  warnedQueueItems.clear();
}

// A queue occurrence is warned at most once per room session. Starting and
// leaving are separate transitions, so either boundary resets the local set.
bus.on('state:network.sessionCode', (code: unknown) => {
  if (!code) resetLargeLocalTrackWarnings();
});

bus.on('state:setup.sessionStarted', (started: unknown) => {
  if (started) resetLargeLocalTrackWarnings();
});

/** @internal Test-only reset for the module-local per-session set. */
export function resetLargeLocalTrackWarningsForTests(): void {
  resetLargeLocalTrackWarnings();
}
