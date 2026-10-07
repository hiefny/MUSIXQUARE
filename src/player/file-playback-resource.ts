/** Common identity and lifetime for complete-PCM and bounded-PCM file playback. */
export interface LargeAudioPlayback {
  readonly ended: boolean;
  stop(): void;
  disconnect(): void;
}

export interface LargeAudioTrack {
  readonly kind: 'large-audio';
  readonly duration: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  readonly bufferedPcmBytes: number;
  prepare(position: number, signal?: AbortSignal): Promise<void>;
  createPlayback(options: {
    context: AudioContext;
    destination: AudioNode;
    when: number;
    offset: number;
    onended(): void;
    onerror(error: unknown): void;
  }): LargeAudioPlayback;
  dispose(): void;
}

export type FilePlaybackResource = AudioBuffer | LargeAudioTrack;

export interface LargeFileSource {
  readonly kind: 'large-audio-source';
  buffer: LargeAudioTrack | null;
  readonly ended: boolean;
  onended: ((event: Event) => void) | null;
  start(when: number, offset: number): void;
  stop(): void;
  disconnect(): void;
}

export type FilePlaybackSource = AudioBufferSourceNode | LargeFileSource;

export function isLargeAudioTrack(
  resource: FilePlaybackResource | null,
): resource is LargeAudioTrack {
  return resource !== null && 'kind' in resource && resource.kind === 'large-audio';
}

export function isLargeFileSource(source: FilePlaybackSource | null): source is LargeFileSource {
  return source !== null && 'kind' in source && source.kind === 'large-audio-source';
}

const owners = new WeakMap<LargeAudioTrack, number>();

/** Native buffers use GC; a bounded decoder also owns iterators that need disposal. */
export function retainFilePlaybackResource(resource: FilePlaybackResource | null): void {
  if (!isLargeAudioTrack(resource)) return;
  owners.set(resource, (owners.get(resource) ?? 0) + 1);
}

export function releaseFilePlaybackResource(resource: FilePlaybackResource | null): void {
  if (!isLargeAudioTrack(resource)) return;
  const remaining = (owners.get(resource) ?? 0) - 1;
  if (remaining > 0) {
    owners.set(resource, remaining);
  } else if (owners.has(resource)) {
    owners.delete(resource);
    resource.dispose();
  }
}
