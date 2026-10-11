import { createLinkedAbortScope, raceWithAbortSignal } from '../core/request-lifetime.ts';

/**
 * Local metadata only: no playback, AudioContext, full PCM decode or external
 * media URLs. The transfer runs concurrently and can cancel this optional work.
 */
export async function probeProRoomUploadDuration(
  file: Blob,
  signal?: AbortSignal,
): Promise<number | null> {
  if (!Number.isSafeInteger(file.size) || file.size < 4 || signal?.aborted) return null;
  const scope = createLinkedAbortScope(signal, 5000, 'PRO_UPLOAD_METADATA_TIMEOUT');
  try {
    const { readProRoomFileDuration } = await raceWithAbortSignal(
      import('../../cloudflare/pro-room-media-duration.ts'),
      scope.signal,
    );
    // Unknown/ambiguous containers (including Ogg granule timelines) stay
    // unknown here. Actual playback preparation can later report its duration.
    return await raceWithAbortSignal(
      readProRoomFileDuration(
        {
          get: async (_key, { range }) => {
            if (scope.signal.aborted) return null;
            return {
              size: file.size,
              body: file.slice(range.offset, range.offset + range.length).stream(),
            };
          },
        },
        'local-file',
        file.size,
        scope.signal,
      ),
      scope.signal,
    );
  } catch {
    return null;
  } finally {
    scope.abort();
    scope.cleanup();
  }
}
