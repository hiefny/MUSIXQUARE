/**
 * Web Audio double for graph-topology tests. Nodes record their outgoing
 * connections, and a targeted disconnect throws like the native API when the
 * connection is missing. Params evaluate setValueAtTime/linear-ramp
 * automation against the manually advanced `currentTime`, so a frozen
 * context keeps a ramp where it was. `trace` records connection changes,
 * impulse installs and automation calls in order.
 */

export type FakeTraceEntry =
  | { op: 'connect' | 'disconnect'; from: FakeNode; to: FakeNode | null }
  | { op: 'buffer'; node: FakeNode }
  | { op: 'set' | 'ramp'; param: FakeParam; value: number; time: number };

export interface FakeParam {
  value: number;
  cancelScheduledValues(time: number): void;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
}

export interface FakeNode {
  readonly kind: string;
  readonly context: FakeAudioContext;
  readonly outputs: Set<FakeNode>;
  readonly gain: FakeParam;
  readonly frequency: FakeParam;
  readonly delayTime: FakeParam;
  type: string;
  buffer: unknown;
  channelCount: number;
  channelCountMode: string;
  channelInterpretation: string;
  connect(destination: FakeNode): FakeNode;
  disconnect(destination?: FakeNode): void;
  [property: string]: unknown;
}

export interface FakeAudioContext {
  state: string;
  currentTime: number;
  readonly sampleRate: number;
  readonly destination: FakeNode;
  readonly trace: FakeTraceEntry[];
  addEventListener(): void;
  removeEventListener(): void;
  [factory: string]: unknown;
}

interface ParamEvent {
  ramp: boolean;
  value: number;
  time: number;
}

function createParam(context: FakeAudioContext, initial: number): FakeParam {
  const events: ParamEvent[] = [];
  let intrinsic = initial;
  const insert = (event: ParamEvent) => {
    const index = events.findIndex((other) => other.time > event.time);
    events.splice(index === -1 ? events.length : index, 0, event);
  };
  const param: FakeParam = {
    get value() {
      let value = intrinsic;
      let time = Number.NEGATIVE_INFINITY;
      for (const event of events) {
        if (event.time <= context.currentTime) {
          value = event.value;
          time = event.time;
          continue;
        }
        if (event.ramp && Number.isFinite(time)) {
          value += (event.value - value) * ((context.currentTime - time) / (event.time - time));
        }
        break;
      }
      return value;
    },
    set value(value: number) {
      // Like the native setter: setValueAtTime(value, currentTime).
      intrinsic = value;
      param.setValueAtTime(value, context.currentTime);
    },
    cancelScheduledValues(time) {
      for (let index = events.length - 1; index >= 0; index--) {
        if (events[index]!.time >= time) events.splice(index, 1);
      }
    },
    setValueAtTime(value, time) {
      insert({ ramp: false, value, time });
      context.trace.push({ op: 'set', param, value, time });
    },
    linearRampToValueAtTime(value, time) {
      insert({ ramp: true, value, time });
      context.trace.push({ op: 'ramp', param, value, time });
    },
  };
  return param;
}

const PARAM_NAMES = [
  'gain',
  'frequency',
  'Q',
  'delayTime',
  'threshold',
  'knee',
  'ratio',
  'attack',
  'release',
] as const;

function createNode(context: FakeAudioContext, kind: string): FakeNode {
  const outputs = new Set<FakeNode>();
  let buffer: unknown = null;
  const node = {
    kind,
    context,
    outputs,
    type: '',
    channelCount: 2,
    channelCountMode: 'max',
    channelInterpretation: 'speakers',
    get buffer() {
      return buffer;
    },
    set buffer(value: unknown) {
      buffer = value;
      context.trace.push({ op: 'buffer', node });
    },
    connect(destination: FakeNode) {
      outputs.add(destination);
      context.trace.push({ op: 'connect', from: node, to: destination });
      return destination;
    },
    disconnect(destination?: FakeNode) {
      if (destination === undefined) outputs.clear();
      else if (!outputs.delete(destination)) {
        throw new DOMException('The node is not connected', 'InvalidAccessError');
      }
      context.trace.push({ op: 'disconnect', from: node, to: destination ?? null });
    },
  } as unknown as FakeNode;
  for (const name of PARAM_NAMES) {
    (node as Record<string, unknown>)[name] = createParam(context, name === 'gain' ? 1 : 0);
  }
  return node;
}

export function createFakeAudioContext(sampleRate = 48_000): FakeAudioContext {
  const context = {
    state: 'running',
    currentTime: 0,
    sampleRate,
    trace: [],
    addEventListener() {},
    removeEventListener() {},
    createBuffer: (channels: number, length: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, numberOfChannels: channels, getChannelData: (i: number) => data[i] };
    },
  } as unknown as FakeAudioContext;
  (context as { destination: FakeNode }).destination = createNode(context, 'destination');
  for (const kind of [
    'Gain',
    'ChannelSplitter',
    'ChannelMerger',
    'BiquadFilter',
    'Convolver',
    'Delay',
    'DynamicsCompressor',
    'WaveShaper',
    'Analyser',
    'MediaStreamSource',
  ]) {
    context[`create${kind}`] = () => createNode(context, kind);
  }
  return context;
}

/** Inputs that `source` currently feeds, by node kind. */
export function connectedKinds(source: FakeNode): string[] {
  return [...source.outputs].map((node) => node.kind).sort();
}
