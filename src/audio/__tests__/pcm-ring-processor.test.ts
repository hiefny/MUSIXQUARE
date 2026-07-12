import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const PROTOCOL_VERSION = 1;
const SAMPLE_RATE = 48_000;
const processorSource = readFileSync(
  new URL('../worklets/pcm-ring-processor.js', import.meta.url),
  'utf8',
);

type WorkletMessage = Record<string, unknown>;

class FakeMessagePort {
  readonly messages: WorkletMessage[] = [];
  onmessage: ((event: { data: WorkletMessage }) => void) | null = null;
  started = false;
  closed = false;

  postMessage(message: WorkletMessage): void {
    if (this.closed) throw new Error('port is closed');
    this.messages.push(message);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  dispatch(message: WorkletMessage): void {
    this.onmessage?.({ data: message });
  }
}

interface ProcessorInstance {
  readonly port: FakeMessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  [key: string]: unknown;
}

interface Harness {
  readonly processor: ProcessorInstance;
  readonly control: FakeMessagePort;
  readonly sandbox: { currentFrame: number };
  readonly channels: number;
  render(frames?: number): Float32Array[];
  bind(generation?: number): FakeMessagePort;
}

const RUN = {
  revision: 7,
  runId: 'run-7',
  rendezvousId: 'rv-7',
} as const;

function command(type: string, generation = 1, fields: WorkletMessage = {}): WorkletMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    generation,
    ...fields,
  };
}

function createHarness(
  channels = 2,
  options: { generation?: number; mediaFrame?: number } = {},
): Harness {
  let registeredName = '';
  let ProcessorConstructor:
    | (new (options: { processorOptions: WorkletMessage }) => ProcessorInstance)
    | undefined;

  class FakeAudioWorkletProcessor {
    readonly port = new FakeMessagePort();
  }

  const sandbox = {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (
      name: string,
      constructor: new (options: { processorOptions: WorkletMessage }) => ProcessorInstance,
    ) => {
      registeredName = name;
      ProcessorConstructor = constructor;
    },
    sampleRate: SAMPLE_RATE,
    currentFrame: 0,
    Array,
    ArrayBuffer,
    Float32Array,
    Math,
    Number,
    RangeError,
  };

  vm.runInNewContext(processorSource, sandbox, { filename: 'pcm-ring-processor.js' });
  expect(registeredName).toBe('musixquare-pcm-ring-v2');
  if (!ProcessorConstructor) throw new Error('processor was not registered');

  const processor = new ProcessorConstructor({
    processorOptions: {
      channels,
      capacitySeconds: 6,
      primeSeconds: 1,
      generation: options.generation ?? 1,
      mediaFrame: options.mediaFrame ?? 0,
    },
  });
  const control = processor.port;

  return {
    processor,
    control,
    sandbox,
    channels,
    render(frames = 128): Float32Array[] {
      const output = Array.from({ length: channels }, () => new Float32Array(frames));
      processor.process([], [output]);
      sandbox.currentFrame += frames;
      return output;
    },
    bind(generation = options.generation ?? 1): FakeMessagePort {
      const pcmPort = new FakeMessagePort();
      control.dispatch(command('bind-pcm-port', generation, { port: pcmPort }));
      return pcmPort;
    },
  };
}

function channelBuffer(values: readonly number[]): ArrayBuffer {
  return Float32Array.from(values).buffer;
}

function supply(
  port: FakeMessagePort,
  generation: number,
  channels: readonly (readonly number[])[],
  final = false,
): void {
  const frames = channels[0]?.length ?? 0;
  port.dispatch(
    command('pcm', generation, {
      frames,
      channels: channels.map(channelBuffer),
      final,
    }),
  );
}

function events(port: FakeMessagePort, type: string): WorkletMessage[] {
  return port.messages.filter((message) => message.type === type);
}

function armAndFinalize(
  harness: Harness,
  targetFrame: number,
  fields: WorkletMessage = {},
  generation = 1,
): void {
  harness.control.dispatch(
    command('arm', generation, { ...RUN, targetFrame, fadeInFrames: 0, ...fields }),
  );
  harness.control.dispatch(command('finalize', generation, RUN));
}

describe('musixquare-pcm-ring-v2', () => {
  it('keeps exactly one versioned demand outstanding', () => {
    const harness = createHarness(1);
    const pcmPort = harness.bind();

    expect(events(pcmPort, 'need')).toEqual([
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'need',
        generation: 1,
        maxFrames: 32_768,
      },
    ]);
    harness.render(1_024);
    harness.render(1_024);
    expect(events(pcmPort, 'need')).toHaveLength(1);

    supply(pcmPort, 1, [[0.25, 0.5]], false);
    expect(events(pcmPort, 'need')).toHaveLength(2);
  });

  it.each([1, 2, 8])('allocates and renders %i independent channels', (channelCount) => {
    const harness = createHarness(channelCount);
    const pcmPort = harness.bind();
    const supplied = Array.from({ length: channelCount }, (_, channel) =>
      Array.from({ length: 6 }, () => channel + 1),
    );

    supply(pcmPort, 1, supplied, true);
    armAndFinalize(harness, 3);
    const output = harness.render(12);

    expect(events(harness.control, 'primed')).toEqual([
      expect.objectContaining({
        generation: 1,
        bufferedFrames: 6,
        channels: channelCount,
        sampleRate: SAMPLE_RATE,
      }),
    ]);
    for (let channel = 0; channel < channelCount; channel += 1) {
      expect(Array.from(output[channel].slice(0, 3))).toEqual([0, 0, 0]);
      expect(Array.from(output[channel].slice(3, 9))).toEqual(
        Array.from({ length: 6 }, () => channel + 1),
      );
    }
    expect(events(harness.control, 'finished')).toEqual([
      expect.objectContaining({ generation: 1, mediaFrame: 6 }),
    ]);
  });

  it('primes a short track as soon as the final PCM block arrives', () => {
    const harness = createHarness();
    const pcmPort = harness.bind();

    supply(
      pcmPort,
      1,
      [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      true,
    );

    expect(events(harness.control, 'primed')).toEqual([
      expect.objectContaining({ bufferedFrames: 2, channels: 2 }),
    ]);
    expect(harness.processor.state).toBe('ready');
  });

  it('allows an empty EOF source to start and finish at the rendezvous frame', () => {
    const harness = createHarness(1);
    const pcmPort = harness.bind();
    pcmPort.dispatch(command('eof'));

    expect(events(harness.control, 'primed')).toEqual([
      expect.objectContaining({ bufferedFrames: 0 }),
    ]);
    armAndFinalize(harness, 2);
    const output = harness.render(8);

    expect(Array.from(output[0])).toEqual(Array.from({ length: 8 }, () => 0));
    expect(events(harness.control, 'started')).toEqual([
      expect.objectContaining({ actualStartFrame: 2, mediaFrame: 0 }),
    ]);
    expect(events(harness.control, 'finished')).toEqual([
      expect.objectContaining({ mediaFrame: 0 }),
    ]);
  });

  it('starts only at the exact finalized render frame and reports the media base', () => {
    const harness = createHarness(2, { mediaFrame: 900 });
    const pcmPort = harness.bind();
    supply(
      pcmPort,
      1,
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      true,
    );

    armAndFinalize(harness, 5);
    const output = harness.render(10);

    expect(Array.from(output[0])).toEqual([0, 0, 0, 0, 0, 1, 2, 3, 0, 0]);
    expect(events(harness.control, 'armed')[0]).toEqual(
      expect.objectContaining({ ...RUN, targetFrame: 5 }),
    );
    expect(events(harness.control, 'finalized')[0]).toEqual(
      expect.objectContaining({ ...RUN, targetFrame: 5 }),
    );
    expect(events(harness.control, 'started')[0]).toEqual(
      expect.objectContaining({
        ...RUN,
        targetFrame: 5,
        actualStartFrame: 5,
        mediaFrame: 900,
      }),
    );
  });

  it('rejects an arm that reaches its target without finalize and stays silent', () => {
    const harness = createHarness(1);
    const pcmPort = harness.bind();
    supply(pcmPort, 1, [[1, 2, 3, 4]], true);
    harness.control.dispatch(command('arm', 1, { ...RUN, targetFrame: 4, fadeInFrames: 0 }));

    const output = harness.render(10);

    expect(Array.from(output[0])).toEqual(Array.from({ length: 10 }, () => 0));
    expect(events(harness.control, 'started')).toHaveLength(0);
    expect(events(harness.control, 'rejected')).toContainEqual(
      expect.objectContaining({ ...RUN, code: 'arm-not-finalized' }),
    );
    expect(harness.processor.state).toBe('ready');
    expect(harness.processor.bufferedFrames).toBe(4);
  });

  it('makes stale generations inert across an atomic reset and seek base', () => {
    const harness = createHarness(1);
    const oldPort = harness.bind();
    expect(events(oldPort, 'need')).toHaveLength(1);

    harness.control.dispatch(command('reset', 2, { mediaFrame: 1_000 }));
    expect(oldPort.closed).toBe(true);
    const pcmPort = harness.bind(2);
    const eventCount = harness.control.messages.length;

    pcmPort.dispatch(
      command('pcm', 1, {
        frames: 2,
        channels: [channelBuffer([8, 9])],
        final: true,
      }),
    );
    harness.control.dispatch(command('reset', 1, { mediaFrame: 0 }));

    expect(harness.control.messages).toHaveLength(eventCount);
    expect(harness.processor.generation).toBe(2);
    expect(harness.processor.mediaFrame).toBe(1_000);
    expect(harness.processor.bufferedFrames).toBe(0);

    supply(pcmPort, 2, [[8, 9]], true);
    armAndFinalize(harness, 2, {}, 2);
    harness.render(8);
    expect(events(harness.control, 'started')[0]).toEqual(
      expect.objectContaining({ generation: 2, mediaFrame: 1_000 }),
    );
    expect(events(harness.control, 'finished')[0]).toEqual(
      expect.objectContaining({ generation: 2, mediaFrame: 1_002 }),
    );
  });

  it('pauses at an exact frame and resumes from the next unread sample', () => {
    const harness = createHarness(1);
    const pcmPort = harness.bind();
    supply(pcmPort, 1, [Array.from({ length: 100 }, (_, index) => index + 1)], true);
    armAndFinalize(harness, 4);

    const first = harness.render(20);
    expect(Array.from(first[0].slice(4))).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );

    harness.control.dispatch(command('pause', 1, { ...RUN, targetFrame: 25 }));
    const pausingQuantum = harness.render(20);
    expect(Array.from(pausingQuantum[0].slice(0, 5))).toEqual([17, 18, 19, 20, 21]);
    expect(Array.from(pausingQuantum[0].slice(5))).toEqual(Array.from({ length: 15 }, () => 0));
    expect(events(harness.control, 'paused')[0]).toEqual(
      expect.objectContaining({
        ...RUN,
        targetFrame: 25,
        actualPauseFrame: 25,
        mediaFrame: 21,
      }),
    );

    armAndFinalize(harness, 44);
    const resumed = harness.render(12);
    expect(Array.from(resumed[0])).toEqual([0, 0, 0, 0, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(events(harness.control, 'started')[1]).toEqual(
      expect.objectContaining({ targetFrame: 44, actualStartFrame: 44, mediaFrame: 21 }),
    );
  });

  it('finishes on the exact final frame without reporting an underrun', () => {
    const harness = createHarness(1);
    const pcmPort = harness.bind();
    supply(pcmPort, 1, [[0.25, 0.5, 0.75]], true);
    armAndFinalize(harness, 10);

    const output = harness.render(20);

    expect(Array.from(output[0].slice(10, 13))).toEqual([0.25, 0.5, 0.75]);
    expect(Array.from(output[0].slice(13))).toEqual(Array.from({ length: 7 }, () => 0));
    expect(events(harness.control, 'finished')).toHaveLength(1);
    expect(events(harness.control, 'interrupted')).toHaveLength(0);
    expect(harness.processor.underruns).toBe(0);
  });

  it('interrupts only the local processor when a primed non-final source underruns', () => {
    const harness = createHarness(1);
    const pcmPort = harness.bind();
    supply(pcmPort, 1, [Array.from({ length: 32_768 }, () => 0.5)]);
    supply(pcmPort, 1, [Array.from({ length: 15_232 }, () => 0.5)]);
    expect(events(harness.control, 'primed')).toHaveLength(1);
    armAndFinalize(harness, 1);

    harness.render(48_002);

    expect(harness.processor.state).toBe('interrupted');
    expect(harness.processor.underruns).toBe(1);
    expect(events(harness.control, 'interrupted')).toEqual([
      expect.objectContaining({ ...RUN, code: 'ring-underrun' }),
    ]);
    expect(harness.processor.process([], [[new Float32Array(128)]])).toBe(true);
  });

  it('rejects wrong channel counts, frame buffers, and ring overflow', () => {
    const wrongChannels = createHarness(2);
    const wrongChannelsPort = wrongChannels.bind();
    supply(wrongChannelsPort, 1, [[1, 2]], false);
    expect(events(wrongChannels.control, 'rejected')).toContainEqual(
      expect.objectContaining({ code: 'pcm-channel-count' }),
    );

    const wrongFrames = createHarness(1);
    const wrongFramesPort = wrongFrames.bind();
    wrongFramesPort.dispatch(
      command('pcm', 1, {
        frames: 2,
        channels: [channelBuffer([1])],
        final: false,
      }),
    );
    expect(events(wrongFrames.control, 'rejected')).toContainEqual(
      expect.objectContaining({ code: 'pcm-channel-frames' }),
    );

    const overflow = createHarness(1);
    const overflowPort = overflow.bind();
    overflow.processor.bufferedFrames = (overflow.processor.capacityFrames as number) - 1;
    overflow.processor.requestOutstanding = true;
    overflow.processor.requestedFrames = 2;
    supply(overflowPort, 1, [[1, 2]], false);
    expect(events(overflow.control, 'rejected')).toContainEqual(
      expect.objectContaining({ code: 'ring-overflow' }),
    );
    expect(overflow.processor.overflows).toBe(1);
    expect(overflow.processor.state).toBe('interrupted');
  });

  it('cancels a matching pending arm without consuming buffered audio', () => {
    const harness = createHarness(1);
    const pcmPort = harness.bind();
    supply(pcmPort, 1, [[1, 2, 3]], true);
    harness.control.dispatch(command('arm', 1, { ...RUN, targetFrame: 5, fadeInFrames: 0 }));
    harness.control.dispatch(command('cancel', 1, RUN));

    const output = harness.render(10);

    expect(Array.from(output[0])).toEqual(Array.from({ length: 10 }, () => 0));
    expect(events(harness.control, 'started')).toHaveLength(0);
    expect(harness.processor.state).toBe('ready');
    expect(harness.processor.bufferedFrames).toBe(3);
  });

  it('applies a deterministic fade across the requested number of frames', () => {
    const harness = createHarness(1);
    const pcmPort = harness.bind();
    supply(pcmPort, 1, [[1, 1, 1, 1]], true);
    armAndFinalize(harness, 2, { fadeInFrames: 4 });

    const output = harness.render(8)[0];

    expect(output[2]).toBe(0);
    expect(output[3]).toBeCloseTo(1 / 3, 6);
    expect(output[4]).toBeCloseTo(2 / 3, 6);
    expect(output[5]).toBe(1);
  });

  it('emits status at 4 Hz and stops idempotently', () => {
    const harness = createHarness(1);
    const pcmPort = harness.bind();

    harness.render(SAMPLE_RATE / 4 - 1);
    expect(events(harness.control, 'status')).toHaveLength(0);
    harness.render(1);
    expect(events(harness.control, 'status')).toEqual([
      expect.objectContaining({
        state: 'priming',
        renderFrame: SAMPLE_RATE / 4,
        mediaFrame: 0,
      }),
    ]);

    harness.control.dispatch(command('stop'));
    harness.control.dispatch(command('stop'));
    expect(pcmPort.closed).toBe(true);
    expect(harness.control.closed).toBe(true);
    expect(harness.processor.process([], [[new Float32Array(128)]])).toBe(false);
  });
});
