import type { ProRoomSnapshot } from './contracts.ts';
import { parseProRoomSnapshot } from './snapshot.ts';

type ProRoomSnapshotApplyOutcome = 'applied' | 'duplicate' | 'stale' | 'conflict' | 'invalid';

interface ProRoomSnapshotApplyResult {
  outcome: ProRoomSnapshotApplyOutcome;
  snapshot: ProRoomSnapshot | null;
}

function snapshotsEqual(left: ProRoomSnapshot, right: ProRoomSnapshot): boolean {
  // Parsed snapshots have an exact v1 key set and contain JSON-only values.
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Pure monotonic application helper. Callers only replace local state with the
 * returned snapshot when the outcome is `applied`; equal-revision divergence is
 * a protocol conflict, never an implicit rebase.
 */
export function applyProRoomSnapshotMonotonically(
  current: ProRoomSnapshot | null,
  incoming: unknown,
): ProRoomSnapshotApplyResult {
  const parsed = parseProRoomSnapshot(incoming);
  if (!parsed) return { outcome: 'invalid', snapshot: current };
  if (!current) return { outcome: 'applied', snapshot: parsed };
  if (parsed.roomCode !== current.roomCode) {
    return { outcome: 'conflict', snapshot: current };
  }
  if (parsed.revision < current.revision) return { outcome: 'stale', snapshot: current };
  if (parsed.revision === current.revision) {
    return snapshotsEqual(parsed, current)
      ? { outcome: 'duplicate', snapshot: current }
      : { outcome: 'conflict', snapshot: current };
  }
  if (
    parsed.playlistRevision < current.playlistRevision ||
    parsed.presence.revision < current.presence.revision ||
    parsed.presence.coordinatorEpoch < current.presence.coordinatorEpoch ||
    parsed.playback.coordinatorEpoch < current.playback.coordinatorEpoch ||
    (parsed.playback.coordinatorEpoch === current.playback.coordinatorEpoch &&
      parsed.playback.revision < current.playback.revision)
  ) {
    return { outcome: 'conflict', snapshot: current };
  }
  return { outcome: 'applied', snapshot: parsed };
}
