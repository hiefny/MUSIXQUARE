import type { QueueItemId } from '../../types/index.ts';
import { getFilePlaybackManager } from '../file-playback-runtime.ts';
import type {
  FilePlaybackSource,
  FilePlaybackSourcePhase,
  FilePlaybackSourceSnapshot,
} from '../file-playback-source.ts';

/** Publishes a lightweight managed source through the real runtime facade. */
export async function publishManagedFilePlaybackSource(
  queueItemId: QueueItemId,
  durationSeconds = 120,
): Promise<FilePlaybackSource> {
  let phase: FilePlaybackSourcePhase = 'new';
  const snapshot = (): FilePlaybackSourceSnapshot => ({
    schemaVersion: 1,
    queueItemId,
    backend: 'bounded-stream',
    phase,
    revision: 0,
    run: null,
    durationSeconds,
    positionSeconds: 0,
    bufferedAheadSeconds: 4,
    outputSampleRateHz: 48_000,
    channelCount: 2,
    underrunCount: 0,
    errorCode: null,
  });
  const source = {
    queueItemId,
    backend: 'bounded-stream',
    async prepare() {
      phase = 'ready';
      return snapshot();
    },
    async connect() {
      phase = 'connected';
      return snapshot();
    },
    getSnapshot: snapshot,
    async destroy() {
      phase = 'destroyed';
    },
  } as unknown as FilePlaybackSource;

  const publication = await getFilePlaybackManager().activate(source, {} as AudioNode);
  if (!publication.published) throw new Error('Managed test source was not published');
  return source;
}
