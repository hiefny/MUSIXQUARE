import {
  AudioSample,
  CustomAudioDecoder,
  registerDecoder,
  type AudioCodec,
  type EncodedPacket,
} from 'mediabunny';
import type { MPEGDecoderWebWorker } from 'mpg123-decoder';
import type { FLACDecoderWebWorker } from '@wasm-audio-decoders/flac';
import { decoderWorkerCall } from './worker-call.ts';
import { IncrementalAacDecoder } from './aac-decoder.ts';

interface DecodedPcm {
  channelData: Float32Array[];
  samplesDecoded: number;
  sampleRate: number;
  errors: readonly { message: string }[];
}

/** One frame at a time in a worker: never full-file WASM input/output arrays. */
abstract class WorkerAudioDecoder extends CustomAudioDecoder {
  protected nextTimestamp: number | null = null;
  protected closed = false;

  protected emit(decoded: DecodedPcm): void {
    if (this.closed) return;
    if (decoded.errors.length > 0) throw new Error(decoded.errors[0].message);
    if (decoded.samplesDecoded === 0) return;
    const channels = this.config.numberOfChannels;
    if (
      decoded.channelData.length < channels ||
      decoded.sampleRate !== this.config.sampleRate ||
      this.nextTimestamp === null
    ) {
      throw new Error('Incremental audio decoder returned invalid channels or timestamps');
    }
    const data = new Float32Array(decoded.samplesDecoded * channels);
    for (let channel = 0; channel < channels; channel++) {
      data.set(decoded.channelData[channel], channel * decoded.samplesDecoded);
    }
    const sample = new AudioSample({
      format: 'f32-planar',
      data,
      sampleRate: decoded.sampleRate,
      numberOfChannels: channels,
      timestamp: this.nextTimestamp,
    });
    this.nextTimestamp += sample.duration;
    this.onSample(sample);
  }
}

class IncrementalMp3Decoder extends WorkerAudioDecoder {
  private decoder: MPEGDecoderWebWorker | null = null;

  static supports(codec: AudioCodec): boolean {
    return codec === 'mp3';
  }

  async init(): Promise<void> {
    const { MPEGDecoderWebWorker } = await import('mpg123-decoder');
    this.decoder = new MPEGDecoderWebWorker({ enableGapless: false });
    await decoderWorkerCall(this.decoder, this.decoder.ready);
  }

  async decode(packet: EncodedPacket): Promise<void> {
    if (this.closed || !this.decoder) return;
    this.nextTimestamp ??= packet.timestamp;
    this.emit(await decoderWorkerCall(this.decoder, this.decoder.decodeFrame(packet.data)));
  }

  async flush(): Promise<void> {
    if (!this.closed && this.decoder) await decoderWorkerCall(this.decoder, this.decoder.reset());
    this.nextTimestamp = null;
  }

  async close(): Promise<void> {
    this.closed = true;
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder) await decoderWorkerCall(decoder, decoder.free()).catch(() => undefined);
  }
}

class IncrementalFlacDecoder extends WorkerAudioDecoder {
  private decoder: FLACDecoderWebWorker | null = null;

  static supports(codec: AudioCodec): boolean {
    return codec === 'flac';
  }

  async init(): Promise<void> {
    const { FLACDecoderWebWorker } = await import('@wasm-audio-decoders/flac');
    this.decoder = new FLACDecoderWebWorker();
    await decoderWorkerCall(this.decoder, this.decoder.ready);
  }

  async decode(packet: EncodedPacket): Promise<void> {
    if (this.closed || !this.decoder) return;
    this.nextTimestamp ??= packet.timestamp;
    this.emit(await decoderWorkerCall(this.decoder, this.decoder.decodeFrames([packet.data])));
  }

  async flush(): Promise<void> {
    if (!this.closed && this.decoder) await decoderWorkerCall(this.decoder, this.decoder.reset());
    this.nextTimestamp = null;
  }

  async close(): Promise<void> {
    this.closed = true;
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder) await decoderWorkerCall(decoder, decoder.free()).catch(() => undefined);
  }
}

let registered = false;

/** MP3 uses one decoder everywhere so priming is consistent in mixed-device rooms. */
export function registerIncrementalAudioDecoders(): void {
  if (registered) return;
  registerDecoder(IncrementalMp3Decoder);
  registerDecoder(IncrementalFlacDecoder);
  registerDecoder(IncrementalAacDecoder);
  registered = true;
}
