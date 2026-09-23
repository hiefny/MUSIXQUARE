import { AudioSample, CustomAudioDecoder, type AudioCodec, type EncodedPacket } from 'mediabunny';
import type { AACDecoderWebWorker } from '@wasm-audio-decoders/aac';
import { decoderWorkerCall } from './worker-call.ts';

const CHANNEL_ORDER: Readonly<Record<number, readonly number[]>> = {
  3: [0, 2, 1],
  4: [0, 2, 1, 3],
  5: [0, 2, 1, 3, 4],
  6: [0, 2, 1, 5, 3, 4],
  7: [0, 2, 1, 6, 5, 3, 4],
  8: [0, 2, 1, 7, 5, 6, 3, 4],
};

/** AAC packets are independent of their M4A or ADTS transport. */
export class IncrementalAacDecoder extends CustomAudioDecoder {
  private decoder: AACDecoderWebWorker | null = null;
  private closed = false;
  private outputFormat: { channels: number; sampleRate: number } | null = null;

  static supports(codec: AudioCodec, config: AudioDecoderConfig | null): boolean {
    // LC, HE-AAC (SBR), and HE-AAC v2 (SBR + PS). In-band SBR may be
    // signalled as LC; the decoder reports its actual output rate/channels.
    return codec === 'aac' && config !== null && /^mp4a\.40\.(0?2|0?5|29)$/.test(config.codec);
  }

  async init(): Promise<void> {
    const { AACDecoderWebWorker } = await import('@wasm-audio-decoders/aac');
    if (this.closed) return;
    const description = this.config.description;
    const audioSpecificConfig = description
      ? ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description)
      : undefined;
    this.decoder = new AACDecoderWebWorker({ audioSpecificConfig });
    await decoderWorkerCall(this.decoder, this.decoder.ready);
  }

  async decode(packet: EncodedPacket): Promise<void> {
    const decoder = this.decoder;
    if (this.closed || !decoder) return;
    const decoded = await decoderWorkerCall(decoder, decoder.decodeFrames([packet.data]));
    if (this.closed) return;
    if (decoded.errors.length > 0) throw new Error(decoded.errors[0].message);
    // FAAD2 consumes the first access unit to prime its filterbank. Its next
    // output belongs to the next packet, not to the priming packet's timestamp.
    if (decoded.samplesDecoded === 0) return;
    const channels = decoded.channelData.length;
    if (
      !Number.isSafeInteger(decoded.samplesDecoded) ||
      decoded.samplesDecoded < 0 ||
      channels < 1 ||
      channels > 8 ||
      !Number.isFinite(decoded.sampleRate) ||
      decoded.sampleRate <= 0 ||
      !Number.isFinite(packet.timestamp) ||
      decoded.channelData.some((channel) => channel.length !== decoded.samplesDecoded)
    ) {
      throw new Error('Incremental AAC decoder returned invalid PCM');
    }
    if (
      this.outputFormat &&
      (this.outputFormat.channels !== channels ||
        this.outputFormat.sampleRate !== decoded.sampleRate)
    ) {
      // A concatenated or corrupt elementary stream must not silently change
      // the sample clock after the demuxer established its packet timeline.
      throw new Error('Incremental AAC output format changed within the track');
    }
    this.outputFormat ??= { channels, sampleRate: decoded.sampleRate };
    // FAAD's wrapper returns L/C/R/.../LFE. Web Audio (and decodeAudioData)
    // uses L/R/C/LFE/... for surround buffers.
    const order = CHANNEL_ORDER[channels];
    const data = new Float32Array(decoded.samplesDecoded * channels);
    for (let channel = 0; channel < channels; channel++) {
      data.set(decoded.channelData[order?.[channel] ?? channel], channel * decoded.samplesDecoded);
    }
    this.onSample(
      new AudioSample({
        format: 'f32-planar',
        data,
        sampleRate: decoded.sampleRate,
        numberOfChannels: channels,
        timestamp: packet.timestamp,
      }),
    );
  }

  async flush(): Promise<void> {
    // decodeFrames consumes one complete access unit per call; there is no
    // transport parser tail to flush. Reset the filterbank for a later seek.
    const decoder = this.decoder;
    if (!this.closed && decoder) await decoderWorkerCall(decoder, decoder.reset());
  }

  async close(): Promise<void> {
    this.closed = true;
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder) await decoderWorkerCall(decoder, decoder.free()).catch(() => undefined);
  }
}
