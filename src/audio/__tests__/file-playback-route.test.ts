import { describe, expect, it } from 'vitest';

import { FilePlaybackRoute } from '../file-playback-route.ts';

interface Connection {
  destination: FakeAudioNode;
  output: number;
  input: number;
}

class FakeAudioNode {
  readonly connections: Connection[] = [];
  disconnectCount = 0;

  constructor(readonly context: FakeAudioContext) {}

  connect(destination: FakeAudioNode, output = 0, input = 0): AudioNode {
    this.connections.push({ destination, output, input });
    return destination as unknown as AudioNode;
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.connections.length = 0;
  }
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = { value: 0 };
  channelCountMode: ChannelCountMode = 'max';
  channelInterpretation: ChannelInterpretation = 'speakers';
}

class FakeAudioContext {
  readonly gains: FakeGainNode[] = [];

  createGain(): GainNode {
    const gain = new FakeGainNode(this);
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }
}

function asNode(node: FakeAudioNode): AudioNode {
  return node as unknown as AudioNode;
}

function asGain(node: FakeGainNode): GainNode {
  return node as unknown as GainNode;
}

function asSplitter(node: FakeAudioNode): ChannelSplitterNode {
  return node as unknown as ChannelSplitterNode;
}

describe('FilePlaybackRoute', () => {
  it('preserves discrete source channels behind one stable input', () => {
    const context = new FakeAudioContext();
    const route = new FilePlaybackRoute(context as unknown as AudioContext);

    expect(route.input.gain.value).toBe(1);
    expect(route.input.channelCountMode).toBe('max');
    expect(route.input.channelInterpretation).toBe('discrete');
    expect(route.destination()).toBeNull();
    expect(route.mode()).toBe('disconnected');
  });

  it('keeps a source connected once while switching stereo to surround and back', () => {
    const context = new FakeAudioContext();
    const source = new FakeAudioNode(context);
    const stereo = new FakeAudioNode(context);
    const splitter = new FakeAudioNode(context);
    const surroundGain = new FakeGainNode(context);
    const preamp = new FakeAudioNode(context);
    const route = new FilePlaybackRoute(context as unknown as AudioContext);
    const input = route.input as unknown as FakeGainNode;

    source.connect(input);
    route.connectStereo(asNode(stereo));
    route.connectSurround(asSplitter(splitter), asGain(surroundGain), asNode(preamp), 2);
    route.connectStereo(asNode(stereo));

    expect(source.connections).toEqual([{ destination: input, output: 0, input: 0 }]);
    expect(source.disconnectCount).toBe(0);
    expect(input.connections).toEqual([{ destination: stereo, output: 0, input: 0 }]);
    expect(route.destination()).toBe(stereo);
    expect(route.mode()).toBe('stereo');
  });

  it('reuses the exact downstream path when the same surround channel is re-enabled', () => {
    const context = new FakeAudioContext();
    const source = new FakeAudioNode(context);
    const stereo = new FakeAudioNode(context);
    const splitter = new FakeAudioNode(context);
    const surroundGain = new FakeGainNode(context);
    const preamp = new FakeAudioNode(context);
    const route = new FilePlaybackRoute(context as unknown as AudioContext);
    const input = route.input as unknown as FakeGainNode;
    source.connect(input);

    route.connectSurround(asSplitter(splitter), asGain(surroundGain), asNode(preamp), 6);
    const downstreamDisconnects = {
      splitter: splitter.disconnectCount,
      gain: surroundGain.disconnectCount,
    };
    route.connectStereo(asNode(stereo));
    route.connectSurround(asSplitter(splitter), asGain(surroundGain), asNode(preamp), 6);

    expect(source.connections).toEqual([{ destination: input, output: 0, input: 0 }]);
    expect(source.disconnectCount).toBe(0);
    expect(input.connections).toEqual([{ destination: splitter, output: 0, input: 0 }]);
    expect({
      splitter: splitter.disconnectCount,
      gain: surroundGain.disconnectCount,
    }).toEqual(downstreamDisconnects);
    expect(splitter.connections).toEqual([
      { destination: surroundGain, output: 6, input: 0 },
      { destination: surroundGain, output: 4, input: 0 },
    ]);
  });

  it('builds one LFE path and treats an identical switch as a no-op', () => {
    const context = new FakeAudioContext();
    const splitter = new FakeAudioNode(context);
    const surroundGain = new FakeGainNode(context);
    const preamp = new FakeAudioNode(context);
    const route = new FilePlaybackRoute(context as unknown as AudioContext);
    const input = route.input as unknown as FakeGainNode;

    route.connectSurround(asSplitter(splitter), asGain(surroundGain), asNode(preamp), 3);
    const counts = {
      input: input.disconnectCount,
      splitter: splitter.disconnectCount,
      gain: surroundGain.disconnectCount,
    };
    route.connectSurround(asSplitter(splitter), asGain(surroundGain), asNode(preamp), 3);

    expect(input.connections).toEqual([{ destination: splitter, output: 0, input: 0 }]);
    expect(splitter.connections).toEqual([{ destination: surroundGain, output: 3, input: 0 }]);
    expect(surroundGain.connections).toEqual([{ destination: preamp, output: 0, input: 0 }]);
    expect({
      input: input.disconnectCount,
      splitter: splitter.disconnectCount,
      gain: surroundGain.disconnectCount,
    }).toEqual(counts);
    expect(route.mode()).toBe('surround');
  });

  it('changes only splitter mappings when the selected surround channel changes', () => {
    const context = new FakeAudioContext();
    const splitter = new FakeAudioNode(context);
    const surroundGain = new FakeGainNode(context);
    const preamp = new FakeAudioNode(context);
    const route = new FilePlaybackRoute(context as unknown as AudioContext);
    const input = route.input as unknown as FakeGainNode;

    route.connectSurround(asSplitter(splitter), asGain(surroundGain), asNode(preamp), 2);
    const inputDisconnects = input.disconnectCount;
    const gainDisconnects = surroundGain.disconnectCount;
    route.connectSurround(asSplitter(splitter), asGain(surroundGain), asNode(preamp), 6);

    expect(input.disconnectCount).toBe(inputDisconnects);
    expect(surroundGain.disconnectCount).toBe(gainDisconnects);
    expect(splitter.connections).toEqual([
      { destination: surroundGain, output: 6, input: 0 },
      { destination: surroundGain, output: 4, input: 0 },
    ]);
  });

  it('folds both rear selections into their matching 5.1 side channels', () => {
    const context = new FakeAudioContext();
    const splitter = new FakeAudioNode(context);
    const surroundGain = new FakeGainNode(context);
    const preamp = new FakeAudioNode(context);
    const route = new FilePlaybackRoute(context as unknown as AudioContext);

    route.connectSurround(asSplitter(splitter), asGain(surroundGain), asNode(preamp), 7);

    expect(splitter.connections.map(({ output }) => output)).toEqual([7, 5]);
  });

  it('rejects invalid nodes before changing the current path', () => {
    const context = new FakeAudioContext();
    const stereo = new FakeAudioNode(context);
    const foreign = new FakeAudioNode(new FakeAudioContext());
    const route = new FilePlaybackRoute(context as unknown as AudioContext);
    const input = route.input as unknown as FakeGainNode;
    route.connectStereo(asNode(stereo));

    expect(() => route.connectStereo(asNode(foreign))).toThrow(/another AudioContext/);
    expect(() =>
      route.connectSurround(
        asSplitter(new FakeAudioNode(context)),
        asGain(new FakeGainNode(context)),
        asNode(stereo),
        8,
      ),
    ).toThrow(/integer from 0 to 7/);
    expect(input.connections).toEqual([{ destination: stereo, output: 0, input: 0 }]);
  });

  it('tears down every owned connection idempotently', () => {
    const context = new FakeAudioContext();
    const splitter = new FakeAudioNode(context);
    const surroundGain = new FakeGainNode(context);
    const preamp = new FakeAudioNode(context);
    const route = new FilePlaybackRoute(context as unknown as AudioContext);
    const input = route.input as unknown as FakeGainNode;
    route.connectSurround(asSplitter(splitter), asGain(surroundGain), asNode(preamp), 0);

    route.destroy();
    const counts = [input.disconnectCount, splitter.disconnectCount, surroundGain.disconnectCount];
    route.destroy();

    expect([input.disconnectCount, splitter.disconnectCount, surroundGain.disconnectCount]).toEqual(
      counts,
    );
    expect(route.destination()).toBeNull();
    expect(route.mode()).toBe('disconnected');
    expect(() => route.connectStereo(asNode(preamp))).toThrow(/destroyed/);
  });
});
