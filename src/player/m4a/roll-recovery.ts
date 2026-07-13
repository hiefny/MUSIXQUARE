import { IsoBmffBoxReader } from '../mp4/box-reader.ts';
import { EncodedSourceIntegrityError } from '../sources/encoded-audio-source.ts';
import {
  assertM4aRollRecoverySampleGroupLayoutProvenance,
  type M4aRollRecoverySampleGroupLayout,
} from './sample-table-layout.ts';
import { M4A_AAC_MAX_ACCESS_UNITS } from './timeline.ts';

const SGPD_ROLL_BODY_BYTES = 18;
const SBGP_ROLL_BODY_BYTES = 20;

export interface M4aAacRollRecoveryEvidence {
  readonly requiredPrerollAccessUnits: 1;
}

export class M4aRollRecoveryError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aRollRecoveryError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        value: cause,
      });
    }
  }
}

function requireReaderAndSignal(
  reader: unknown,
  signal: unknown,
): asserts reader is IsoBmffBoxReader {
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError('M4A AAC roll-recovery reader requires an IsoBmffBoxReader');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A AAC roll-recovery reader requires an AbortSignal');
  }
}

function requireExpectedAccessUnitCount(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 1 ||
    value > M4A_AAC_MAX_ACCESS_UNITS
  ) {
    throw new RangeError(
      `M4A expected AAC access-unit count must be from 1 through ${M4A_AAC_MAX_ACCESS_UNITS}`,
    );
  }
  return value;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x100_0000 +
    bytes[offset + 1]! * 0x1_0000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function hasGroupingTypeRoll(bytes: Uint8Array): boolean {
  return bytes[4] === 0x72 && bytes[5] === 0x6f && bytes[6] === 0x6c && bytes[7] === 0x6c;
}

function requireExactRollSgpd(bytes: Uint8Array): void {
  if (bytes[0] !== 1 || bytes[1] !== 0 || bytes[2] !== 0 || bytes[3] !== 0) {
    throw new M4aRollRecoveryError('M4A AAC roll sgpd must use FullBox version 1 and flags 0');
  }
  if (!hasGroupingTypeRoll(bytes)) {
    throw new M4aRollRecoveryError('M4A AAC sgpd grouping type must be "roll"');
  }
  if (readUint32(bytes, 8) !== 2) {
    throw new M4aRollRecoveryError('M4A AAC roll sgpd default length must be 2');
  }
  if (readUint32(bytes, 12) !== 1) {
    throw new M4aRollRecoveryError('M4A AAC roll sgpd must contain exactly one description');
  }
  if (bytes[16] !== 0xff || bytes[17] !== 0xff) {
    throw new M4aRollRecoveryError('M4A AAC roll distance must be exactly -1');
  }
}

function requireExactRollSbgp(bytes: Uint8Array, expectedAccessUnitCount: number): void {
  if (bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 0 || bytes[3] !== 0) {
    throw new M4aRollRecoveryError('M4A AAC roll sbgp must use FullBox version 0 and flags 0');
  }
  if (!hasGroupingTypeRoll(bytes)) {
    throw new M4aRollRecoveryError('M4A AAC sbgp grouping type must be "roll"');
  }
  if (readUint32(bytes, 8) !== 1) {
    throw new M4aRollRecoveryError('M4A AAC roll sbgp must contain exactly one run');
  }
  if (readUint32(bytes, 12) !== expectedAccessUnitCount) {
    throw new M4aRollRecoveryError(
      'M4A AAC roll sbgp run must cover the exact AAC access-unit count',
    );
  }
  if (readUint32(bytes, 16) !== 1) {
    throw new M4aRollRecoveryError('M4A AAC roll sbgp group-description index must be exactly 1');
  }
}

/**
 * Admit only FFmpeg's exact non-fragmented AAC `roll` recovery pair. The
 * retained box references remain bound to their issuing reader, and neither
 * body is large enough to approach the reader's 64-KiB physical-read ceiling.
 */
export async function readM4aAacRollRecoveryEvidence(
  reader: IsoBmffBoxReader,
  sampleGroup: Readonly<M4aRollRecoverySampleGroupLayout> | null,
  expectedAccessUnitCount: number,
  signal: AbortSignal,
): Promise<Readonly<M4aAacRollRecoveryEvidence> | null> {
  requireReaderAndSignal(reader, signal);
  reader.assertReadable(signal);
  const accessUnitCount = requireExpectedAccessUnitCount(expectedAccessUnitCount);
  if (sampleGroup === null) return null;

  const boxes = assertM4aRollRecoverySampleGroupLayoutProvenance(reader, sampleGroup, signal);
  const sgpdBody = reader.createChildCursor(boxes.sgpd);
  const sbgpBody = reader.createChildCursor(boxes.sbgp);
  if (boxes.sgpd.type !== 'sgpd' || boxes.sbgp.type !== 'sbgp') {
    throw new M4aRollRecoveryError('M4A roll-recovery layout must contain sgpd and sbgp boxes');
  }
  if (sgpdBody.remainingBytes !== SGPD_ROLL_BODY_BYTES) {
    throw new M4aRollRecoveryError(
      `M4A AAC roll sgpd body has ${sgpdBody.remainingBytes} bytes; expected ${SGPD_ROLL_BODY_BYTES}`,
    );
  }
  if (sbgpBody.remainingBytes !== SBGP_ROLL_BODY_BYTES) {
    throw new M4aRollRecoveryError(
      `M4A AAC roll sbgp body has ${sbgpBody.remainingBytes} bytes; expected ${SBGP_ROLL_BODY_BYTES}`,
    );
  }

  const sgpd = await reader.readBytes(sgpdBody.start, SGPD_ROLL_BODY_BYTES, signal);
  requireExactRollSgpd(sgpd);
  const sbgp = await reader.readBytes(sbgpBody.start, SBGP_ROLL_BODY_BYTES, signal);
  requireExactRollSbgp(sbgp, accessUnitCount);

  reader.assertReadable(signal);
  return Object.freeze({ requiredPrerollAccessUnits: 1 });
}
