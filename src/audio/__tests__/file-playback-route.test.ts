import { describe, expect, it } from 'vitest';

import { FilePlaybackRoute } from '../file-playback-route.ts';

class FakeGainNode {
  readonly gain = { value: 0 };
  channelCountMode: ChannelCountMode = 'max';
  channelInterpretation: ChannelInterpretation = 'speakers';
  readonly connections: FakeAudioNode[] = [];
  disconnectCount = 0;

  constructor(readonly context: FakeAudioContext) {}

  connect(destination: FakeAudioNode): AudioNode {
    this.connections.push(destination);
    return destination as unknown as AudioNode;
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.connections.length = 0;
  }
}

class FakeAudioNode {
  constructor(readonly context: FakeAudioContext) {}
}

class FakeAudioContext {
  readonly gains: FakeGainNode[] = [];

  createGain(): GainNode {
    const gain = new FakeGainNode(this);
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }
}

describe('FilePlaybackRoute', () => {
  it('preserves discrete source channels behind one stable input', () => {
    const context = new FakeAudioContext();
    const route = new FilePlaybackRoute(context as unknown as AudioContext);

    expect(route.input.gain.value).toBe(1);
    expect(route.input.channelCountMode).toBe('max');
    expect(route.input.channelInterpretation).toBe('discrete');
    expect(route.destination()).toBeNull();
  });

  it('switches destinations without replacing its input node', () => {
    const context = new FakeAudioContext();
    const stereo = new FakeAudioNode(context);
    const surround = new FakeAudioNode(context);
    const route = new FilePlaybackRoute(context as unknown as AudioContext);
    const input = route.input as unknown as FakeGainNode;

    route.connect(stereo as unknown as AudioNode);
    expect(input.connections).toEqual([stereo]);
    expect(route.destination()).toBe(stereo);

    route.connect(stereo as unknown as AudioNode);
    expect(input.disconnectCount).toBe(1);

    route.connect(surround as unknown as AudioNode);
    expect(input.disconnectCount).toBe(2);
    expect(input.connections).toEqual([surround]);
    expect(route.destination()).toBe(surround);
  });

  it('rejects foreign contexts and tears down idempotently', () => {
    const context = new FakeAudioContext();
    const route = new FilePlaybackRoute(context as unknown as AudioContext);
    const foreign = new FakeAudioNode(new FakeAudioContext());

    expect(() => route.connect(foreign as unknown as AudioNode)).toThrow(/another AudioContext/);
    route.destroy();
    route.destroy();
    expect(route.destination()).toBeNull();
    expect(() => route.connect(new FakeAudioNode(context) as unknown as AudioNode)).toThrow(
      /destroyed/,
    );
  });
});
