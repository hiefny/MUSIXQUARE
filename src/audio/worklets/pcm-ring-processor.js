/*
 * MUSIXQUARE bounded PCM ring AudioWorklet.
 *
 * This file deliberately has no imports: Vite turns its URL into a hashed
 * production asset, while the AudioWorklet global scope executes it directly.
 */

const PCM_RING_PROTOCOL_VERSION = 1;
const PCM_RING_MAX_CHANNELS = 8;
const PCM_RING_MAX_MESSAGE_FRAMES = 32_768;
const PCM_RING_DEFAULT_CAPACITY_SECONDS = 12;
const PCM_RING_DEFAULT_PRIME_SECONDS = 4;
const PCM_RING_MIN_CAPACITY_SECONDS = 6;
const PCM_RING_MAX_CAPACITY_SECONDS = 20;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isGeneration(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isMediaFrame(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRunIdentity(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    typeof value.rendezvousId === 'string' &&
    value.rendezvousId.length > 0
  );
}

function sameRunIdentity(left, right) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    left.revision === right.revision &&
    left.runId === right.runId &&
    left.rendezvousId === right.rendezvousId
  );
}

function identityFields(identity) {
  if (!identity) return {};
  return {
    revision: identity.revision,
    runId: identity.runId,
    rendezvousId: identity.rendezvousId,
  };
}

class MusixquarePcmRingV2Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = options?.processorOptions ?? {};
    const channels = processorOptions.channels ?? 2;
    if (!Number.isSafeInteger(channels) || channels < 1 || channels > PCM_RING_MAX_CHANNELS) {
      throw new RangeError(`channels must be an integer from 1 to ${PCM_RING_MAX_CHANNELS}`);
    }

    const requestedCapacity = Number(processorOptions.capacitySeconds);
    const capacitySeconds = clamp(
      Number.isFinite(requestedCapacity) ? requestedCapacity : PCM_RING_DEFAULT_CAPACITY_SECONDS,
      PCM_RING_MIN_CAPACITY_SECONDS,
      PCM_RING_MAX_CAPACITY_SECONDS,
    );
    const requestedPrime = Number(processorOptions.primeSeconds);
    const primeSeconds = clamp(
      Number.isFinite(requestedPrime) ? requestedPrime : PCM_RING_DEFAULT_PRIME_SECONDS,
      1,
      capacitySeconds - 1,
    );

    this.channels = channels;
    this.capacityFrames = Math.max(1, Math.floor(sampleRate * capacitySeconds));
    this.primeFrames = Math.max(1, Math.floor(sampleRate * primeSeconds));
    this.highWaterFrames = Math.max(this.primeFrames, Math.floor(this.capacityFrames * 0.8));
    this.rings = Array.from({ length: channels }, () => new Float32Array(this.capacityFrames));

    this.generation = isGeneration(processorOptions.generation) ? processorOptions.generation : 1;
    this.mediaFrame = isMediaFrame(processorOptions.mediaFrame) ? processorOptions.mediaFrame : 0;

    this.readIndex = 0;
    this.writeIndex = 0;
    this.bufferedFrames = 0;
    this.state = 'priming';
    this.eof = false;
    this.primedSent = false;
    this.underruns = 0;
    this.overflows = 0;
    this.lastStatusFrame = currentFrame;

    this.pcmPort = null;
    this.requestOutstanding = false;
    this.requestedFrames = 0;

    this.runIdentity = null;
    this.armedFromState = 'ready';
    this.targetFrame = null;
    this.finalized = false;
    this.fadeInFrames = 0;
    this.fadePosition = 0;
    this.pauseTargetFrame = null;
    this.pauseIdentity = null;
    this.stopped = false;

    this.port.onmessage = (event) => this.onControlMessage(event.data);
  }

  postEvent(type, fields = {}) {
    if (this.stopped && type !== 'status') return;
    try {
      this.port.postMessage({
        protocolVersion: PCM_RING_PROTOCOL_VERSION,
        type,
        generation: this.generation,
        ...fields,
      });
    } catch {
      // The node can disappear while a render quantum is completing.
    }
  }

  reject(code, identity = this.runIdentity) {
    this.postEvent('rejected', { code, ...identityFields(identity) });
  }

  interrupt(code, identity = this.runIdentity) {
    if (this.state === 'interrupted' || this.state === 'stopped') return;
    this.state = 'interrupted';
    this.pauseTargetFrame = null;
    this.pauseIdentity = null;
    this.requestOutstanding = false;
    this.requestedFrames = 0;
    this.postEvent('interrupted', { code, ...identityFields(identity) });
  }

  onControlMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'reset') {
      this.reset(message);
      return;
    }

    if (message.generation !== this.generation) return;
    if (message.protocolVersion !== PCM_RING_PROTOCOL_VERSION) {
      this.reject('protocol-version');
      return;
    }
    if (this.stopped) return;

    switch (message.type) {
      case 'bind-pcm-port':
        this.bindPcmPort(message.port);
        break;
      case 'arm':
        this.arm(message);
        break;
      case 'finalize':
        this.finalize(message);
        break;
      case 'cancel':
        this.cancel(message);
        break;
      case 'pause':
        this.schedulePause(message);
        break;
      case 'stop':
        this.stop();
        break;
      default:
        this.reject('unknown-command');
        break;
    }
  }

  reset(message) {
    // A generation is a one-shot ownership transfer. Replaying the same reset
    // must not erase an already primed/armed ring after an ACK retry.
    if (!isGeneration(message.generation) || message.generation <= this.generation) return;
    if (message.protocolVersion !== PCM_RING_PROTOCOL_VERSION) {
      if (message.generation === this.generation) this.reject('protocol-version');
      return;
    }
    if (!isMediaFrame(message.mediaFrame) || this.stopped) {
      if (!this.stopped) this.reject('invalid-media-frame');
      return;
    }

    this.closePcmPort();
    for (const ring of this.rings) ring.fill(0);

    this.generation = message.generation;
    this.mediaFrame = message.mediaFrame;
    this.readIndex = 0;
    this.writeIndex = 0;
    this.bufferedFrames = 0;
    this.state = 'priming';
    this.eof = false;
    this.primedSent = false;
    this.underruns = 0;
    this.overflows = 0;
    this.lastStatusFrame = currentFrame;
    this.runIdentity = null;
    this.armedFromState = 'ready';
    this.targetFrame = null;
    this.finalized = false;
    this.fadeInFrames = 0;
    this.fadePosition = 0;
    this.pauseTargetFrame = null;
    this.pauseIdentity = null;
  }

  bindPcmPort(port) {
    if (!port || typeof port.postMessage !== 'function') {
      this.reject('invalid-pcm-port');
      return;
    }

    this.closePcmPort();
    this.pcmPort = port;
    this.requestOutstanding = false;
    this.requestedFrames = 0;
    port.onmessage = (event) => {
      if (this.pcmPort !== port) return;
      this.onPcmMessage(event.data);
    };
    if (typeof port.start === 'function') port.start();
    this.maybeRequestPcm();
  }

  closePcmPort() {
    const port = this.pcmPort;
    this.pcmPort = null;
    this.requestOutstanding = false;
    this.requestedFrames = 0;
    if (!port) return;
    try {
      port.onmessage = null;
      if (typeof port.close === 'function') port.close();
    } catch {
      // MessagePort.close() is best-effort during teardown.
    }
  }

  onPcmMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.generation !== this.generation) return;
    if (message.protocolVersion !== PCM_RING_PROTOCOL_VERSION) {
      this.rejectPcm('protocol-version');
      return;
    }
    if (this.stopped || this.state === 'interrupted') return;

    switch (message.type) {
      case 'pcm':
        this.acceptPcm(message);
        break;
      case 'eof':
        this.acceptEof();
        break;
      case 'source-error':
        this.requestOutstanding = false;
        this.requestedFrames = 0;
        this.interrupt(
          typeof message.code === 'string' && message.code.length > 0
            ? `source-error:${message.code}`
            : 'source-error',
        );
        break;
      default:
        this.rejectPcm('unknown-pcm-message');
        break;
    }
  }

  rejectPcm(code, overflow = false) {
    this.requestOutstanding = false;
    this.requestedFrames = 0;
    if (overflow) this.overflows += 1;
    this.reject(code);
    this.state = 'interrupted';
  }

  acceptPcm(message) {
    if (!this.requestOutstanding) {
      this.rejectPcm('unexpected-pcm');
      return;
    }

    const frames = message.frames;
    if (
      !Number.isSafeInteger(frames) ||
      frames <= 0 ||
      frames > PCM_RING_MAX_MESSAGE_FRAMES ||
      frames > this.requestedFrames
    ) {
      this.rejectPcm('invalid-pcm-frames');
      return;
    }
    if (!Array.isArray(message.channels) || message.channels.length !== this.channels) {
      this.rejectPcm('pcm-channel-count');
      return;
    }
    if (typeof message.final !== 'boolean') {
      this.rejectPcm('invalid-pcm-final');
      return;
    }

    const expectedBytes = frames * Float32Array.BYTES_PER_ELEMENT;
    const channelViews = [];
    for (const buffer of message.channels) {
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== expectedBytes) {
        this.rejectPcm('pcm-channel-frames');
        return;
      }
      channelViews.push(new Float32Array(buffer));
    }

    const freeFrames = this.capacityFrames - this.bufferedFrames;
    if (frames > freeFrames) {
      this.rejectPcm('ring-overflow', true);
      return;
    }

    this.requestOutstanding = false;
    this.requestedFrames = 0;
    const firstRun = Math.min(frames, this.capacityFrames - this.writeIndex);
    const secondRun = frames - firstRun;
    for (let channel = 0; channel < this.channels; channel += 1) {
      const source = channelViews[channel];
      this.rings[channel].set(source.subarray(0, firstRun), this.writeIndex);
      if (secondRun > 0) this.rings[channel].set(source.subarray(firstRun), 0);
    }
    this.writeIndex = (this.writeIndex + frames) % this.capacityFrames;
    this.bufferedFrames += frames;
    if (message.final) this.eof = true;

    this.maybeMarkPrimed();
    this.maybeRequestPcm();
  }

  acceptEof() {
    if (!this.requestOutstanding) {
      this.rejectPcm('unexpected-eof');
      return;
    }
    this.requestOutstanding = false;
    this.requestedFrames = 0;
    this.eof = true;
    this.maybeMarkPrimed();
    if (this.state === 'playing' && this.bufferedFrames === 0) this.finish();
  }

  maybeMarkPrimed() {
    if (this.primedSent) return;
    if (this.bufferedFrames < this.primeFrames && !this.eof) return;
    this.primedSent = true;
    if (this.state === 'priming') this.state = 'ready';
    this.postEvent('primed', {
      bufferedFrames: this.bufferedFrames,
      sampleRate,
      channels: this.channels,
    });
  }

  maybeRequestPcm() {
    if (
      !this.pcmPort ||
      this.requestOutstanding ||
      this.eof ||
      this.stopped ||
      this.state === 'interrupted' ||
      this.state === 'finished'
    ) {
      return;
    }
    if (this.bufferedFrames >= this.highWaterFrames) return;

    const freeFrames = this.capacityFrames - this.bufferedFrames;
    const maxFrames = Math.min(freeFrames, PCM_RING_MAX_MESSAGE_FRAMES);
    if (maxFrames <= 0) return;

    this.requestOutstanding = true;
    this.requestedFrames = maxFrames;
    try {
      this.pcmPort.postMessage({
        protocolVersion: PCM_RING_PROTOCOL_VERSION,
        type: 'need',
        generation: this.generation,
        maxFrames,
      });
    } catch {
      this.requestOutstanding = false;
      this.requestedFrames = 0;
      this.interrupt('pcm-port-closed');
    }
  }

  arm(message) {
    if (!isRunIdentity(message)) {
      this.reject('invalid-run-identity');
      return;
    }
    if (!Number.isSafeInteger(message.targetFrame) || message.targetFrame <= currentFrame) {
      this.reject('invalid-arm-target', message);
      return;
    }
    if (!Number.isSafeInteger(message.fadeInFrames) || message.fadeInFrames < 0) {
      this.reject('invalid-fade-in', message);
      return;
    }

    if (this.state === 'armed') {
      if (
        sameRunIdentity(this.runIdentity, message) &&
        this.targetFrame === message.targetFrame &&
        this.fadeInFrames === message.fadeInFrames
      ) {
        this.postEvent('armed', {
          ...identityFields(this.runIdentity),
          targetFrame: this.targetFrame,
        });
      } else {
        this.reject('arm-busy', message);
      }
      return;
    }

    if ((this.state !== 'ready' && this.state !== 'paused') || !this.primedSent) {
      this.reject('not-ready', message);
      return;
    }

    this.armedFromState = this.state;
    this.state = 'armed';
    this.runIdentity = {
      revision: message.revision,
      runId: message.runId,
      rendezvousId: message.rendezvousId,
    };
    this.targetFrame = message.targetFrame;
    this.finalized = false;
    this.fadeInFrames = message.fadeInFrames;
    this.fadePosition = 0;
    this.pauseTargetFrame = null;
    this.pauseIdentity = null;
    this.postEvent('armed', {
      ...identityFields(this.runIdentity),
      targetFrame: this.targetFrame,
    });
  }

  finalize(message) {
    if (!isRunIdentity(message)) {
      this.reject('invalid-run-identity');
      return;
    }
    if (this.state !== 'armed' || !sameRunIdentity(this.runIdentity, message)) {
      this.reject('finalize-not-armed', message);
      return;
    }
    if (this.finalized) {
      this.postEvent('finalized', {
        ...identityFields(this.runIdentity),
        targetFrame: this.targetFrame,
      });
      return;
    }
    if (this.targetFrame === null || currentFrame >= this.targetFrame) {
      const identity = this.runIdentity;
      this.restoreArmedState();
      this.reject('finalize-too-late', identity);
      return;
    }

    this.finalized = true;
    this.postEvent('finalized', {
      ...identityFields(this.runIdentity),
      targetFrame: this.targetFrame,
    });
  }

  cancel(message) {
    if (!this.cancelMatches(message)) return;

    if (this.state === 'armed') {
      this.restoreArmedState();
      return;
    }
    if (this.state === 'playing') {
      this.interrupt('cancelled-after-start');
      return;
    }
    if (this.state === 'paused') {
      this.runIdentity = null;
      this.pauseTargetFrame = null;
      this.pauseIdentity = null;
    }
  }

  cancelMatches(message) {
    if (!this.runIdentity) return true;
    if (message.revision !== undefined && message.revision !== this.runIdentity.revision)
      return false;
    if (message.runId !== undefined && message.runId !== this.runIdentity.runId) return false;
    if (
      message.rendezvousId !== undefined &&
      message.rendezvousId !== this.runIdentity.rendezvousId
    ) {
      return false;
    }
    return true;
  }

  restoreArmedState() {
    this.state = this.armedFromState === 'paused' ? 'paused' : 'ready';
    this.targetFrame = null;
    this.finalized = false;
    this.fadeInFrames = 0;
    this.fadePosition = 0;
    this.runIdentity = null;
  }

  schedulePause(message) {
    if (!isRunIdentity(message)) {
      this.reject('invalid-run-identity');
      return;
    }
    if (this.state !== 'playing' || !sameRunIdentity(this.runIdentity, message)) {
      this.reject('pause-not-playing', message);
      return;
    }
    if (!Number.isSafeInteger(message.targetFrame) || message.targetFrame < currentFrame) {
      this.reject('invalid-pause-target', message);
      return;
    }

    this.pauseTargetFrame = message.targetFrame;
    this.pauseIdentity = {
      revision: message.revision,
      runId: message.runId,
      rendezvousId: message.rendezvousId,
    };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.state = 'stopped';
    this.targetFrame = null;
    this.pauseTargetFrame = null;
    this.runIdentity = null;
    this.closePcmPort();
    try {
      this.port.onmessage = null;
      if (typeof this.port.close === 'function') this.port.close();
    } catch {
      // Closing an already-disconnected node is harmless.
    }
  }

  startAtTarget(absoluteFrame) {
    if (this.targetFrame === null || absoluteFrame !== this.targetFrame) return false;
    const identity = this.runIdentity;
    if (!this.finalized) {
      this.restoreArmedState();
      this.reject('arm-not-finalized', identity);
      return false;
    }

    this.state = 'playing';
    this.fadePosition = 0;
    this.postEvent('started', {
      ...identityFields(identity),
      targetFrame: this.targetFrame,
      actualStartFrame: absoluteFrame,
      mediaFrame: this.mediaFrame,
    });
    return true;
  }

  pauseAtTarget(absoluteFrame) {
    const identity = this.pauseIdentity ?? this.runIdentity;
    const targetFrame = this.pauseTargetFrame;
    this.state = 'paused';
    this.pauseTargetFrame = null;
    this.pauseIdentity = null;
    this.targetFrame = null;
    this.finalized = false;
    this.postEvent('paused', {
      ...identityFields(identity),
      targetFrame,
      actualPauseFrame: absoluteFrame,
      mediaFrame: this.mediaFrame,
    });
  }

  fadeGain() {
    if (this.fadeInFrames <= 0 || this.fadePosition >= this.fadeInFrames) return 1;
    if (this.fadeInFrames === 1) return 1;
    return this.fadePosition / (this.fadeInFrames - 1);
  }

  consumeFrame(output, outputIndex) {
    const gain = this.fadeGain();
    for (let channel = 0; channel < this.channels; channel += 1) {
      output[channel][outputIndex] = this.rings[channel][this.readIndex] * gain;
    }
    this.readIndex = (this.readIndex + 1) % this.capacityFrames;
    this.bufferedFrames -= 1;
    this.mediaFrame += 1;
    this.fadePosition += 1;
  }

  finish() {
    if (this.state === 'finished') return;
    this.state = 'finished';
    this.targetFrame = null;
    this.pauseTargetFrame = null;
    this.postEvent('finished', { mediaFrame: this.mediaFrame });
  }

  emitStatus(renderFrame) {
    if (renderFrame - this.lastStatusFrame < sampleRate / 4) return;
    this.lastStatusFrame = renderFrame;
    this.postEvent('status', {
      state: this.state,
      bufferedFrames: this.bufferedFrames,
      mediaFrame: this.mediaFrame,
      renderFrame,
      underruns: this.underruns,
      overflows: this.overflows,
    });
  }

  process(_inputs, outputs) {
    if (this.stopped) return false;

    const output = outputs[0];
    const renderFrames = output?.[0]?.length ?? 0;
    if (!output || renderFrames <= 0) return true;
    for (const channel of output) channel.fill(0);

    if (output.length < this.channels) {
      this.interrupt('output-channel-count');
      this.emitStatus(currentFrame + renderFrames);
      return true;
    }

    if (this.state === 'armed' && this.targetFrame < currentFrame) {
      const identity = this.runIdentity;
      this.restoreArmedState();
      this.reject('arm-target-missed', identity);
    }
    if (
      this.state === 'playing' &&
      this.pauseTargetFrame !== null &&
      this.pauseTargetFrame < currentFrame
    ) {
      this.interrupt('pause-target-missed', this.pauseIdentity);
    }

    for (let index = 0; index < renderFrames; index += 1) {
      const absoluteFrame = currentFrame + index;

      if (this.state === 'armed' && absoluteFrame === this.targetFrame) {
        this.startAtTarget(absoluteFrame);
      }

      if (
        this.state === 'playing' &&
        this.pauseTargetFrame !== null &&
        absoluteFrame === this.pauseTargetFrame
      ) {
        this.pauseAtTarget(absoluteFrame);
        break;
      }

      if (this.state !== 'playing') continue;
      if (this.bufferedFrames <= 0) {
        if (this.eof) this.finish();
        else {
          this.underruns += 1;
          this.interrupt('ring-underrun');
        }
        break;
      }

      this.consumeFrame(output, index);
      if (this.eof && this.bufferedFrames === 0) {
        this.finish();
        break;
      }
    }

    this.maybeRequestPcm();
    this.emitStatus(currentFrame + renderFrames);
    return true;
  }
}

registerProcessor('musixquare-pcm-ring-v2', MusixquarePcmRingV2Processor);
