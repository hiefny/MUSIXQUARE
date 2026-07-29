/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG, REMOTE_SHARE_MAX_BYTES } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import type {
  DataConnection,
  FileBoundedV1DeliveryScopeWire,
  FileR2RecordPublicationWire,
  ProtocolMsg,
} from '../../types/index.ts';
import { handleData, registerHandler } from '../protocol.ts';
import { markQueueAuthorityReady } from '../queue-authority.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';
const RECORD_SIZE = 8 * 1024 * 1024;
const scope: FileBoundedV1DeliveryScopeWire = {
  roomEpoch: 'room-epoch-1',
  bridgeGeneration: 'bridge-generation-1',
  bindingId: 'binding-1',
  queueItemId: QUEUE_ITEM_ID,
  sourceIdentity: 'source:bounded-v1:1',
};

function makeConnection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

function publication(): FileR2RecordPublicationWire {
  const encodedSize = RECORD_SIZE + 123;
  return {
    schemaVersion: 1,
    queueItemId: scope.queueItemId,
    sourceIdentity: scope.sourceIdentity,
    transferSessionId: scope.bindingId,
    applicationSessionId: scope.roomEpoch,
    storageRoomId: '123456',
    setId: '00000000-0000-4000-8000-000000000010',
    encodedSize,
    recordSize: RECORD_SIZE,
    recordCount: 2,
    cryptoSecretDescriptor: {
      formatVersion: 2,
      objectId: '00000000-0000-4000-8000-000000000010',
      plaintextSize: encodedSize,
      recordSize: RECORD_SIZE,
      recordCount: 2,
      noncePrefixB64: 'AAAAAAAAAAA=',
      keyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
    records: [
      {
        index: 0,
        objectId: '00000000-0000-4000-8000-000000000011',
        plaintextSize: RECORD_SIZE,
        encryptedSize: RECORD_SIZE + 16,
      },
      {
        index: 1,
        objectId: '00000000-0000-4000-8000-000000000012',
        plaintextSize: 123,
        encryptedSize: 139,
      },
    ],
    name: 'track.m4a',
    mime: 'audio/mp4',
    expiresAtEpochMs: Date.now() + 60_000,
  };
}

function descriptorFrame(): ProtocolMsg<typeof MSG.FILE_R2_RECORD_DESCRIPTOR> {
  return {
    type: MSG.FILE_R2_RECORD_DESCRIPTOR,
    bridgeVersion: 1,
    legacySessionId: 7,
    purpose: 'current',
    scope,
    descriptorId: 'descriptor-1',
    descriptorVersion: 1,
    publication: publication(),
  };
}

function resultFrame(): ProtocolMsg<typeof MSG.FILE_R2_RECORD_RESULT> {
  return {
    type: MSG.FILE_R2_RECORD_RESULT,
    bridgeVersion: 1,
    legacySessionId: 7,
    scope,
    descriptorId: 'descriptor-1',
    descriptorVersion: 1,
    outcome: 'ready',
  };
}

beforeEach(() => {
  resetState();
  bus.clear();
});

describe('bounded V1 wire protocol', () => {
  it('accepts only the explicit r2-record FILE_PREPARE delivery marker', async () => {
    const handler = vi.fn();
    registerHandler(MSG.FILE_PREPARE, handler);
    const conn = makeConnection('peer-bounded-v1-prepare');
    const base = {
      type: MSG.FILE_PREPARE,
      name: 'track.m4a',
      queueItemId: QUEUE_ITEM_ID,
      sessionId: 7,
      mime: 'audio/mp4',
    } as const;

    await handleData({ ...base, delivery: 'r2-record' }, conn);
    await handleData({ ...base, delivery: 'record' }, conn);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ ...base, delivery: 'r2-record' }, conn);
  });

  it('holds a nested-scope descriptor until the active host queue bootstrap is authoritative', async () => {
    const handler = vi.fn();
    registerHandler(MSG.FILE_R2_RECORD_DESCRIPTOR, handler);
    const conn = makeConnection('peer-bounded-v1-queue-gate');
    setState('network.appRole', 'guest');
    setState('network.hostConn', conn);

    await handleData(descriptorFrame(), conn);
    expect(handler).not.toHaveBeenCalled();

    markQueueAuthorityReady(conn);
    await handleData(descriptorFrame(), conn);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('accepts the three exact additive frame shapes without overloading FILE_R2_CAPABILITY', async () => {
    const capability = vi.fn();
    const descriptor = vi.fn();
    const result = vi.fn();
    const legacyCapability = vi.fn();
    registerHandler(MSG.FILE_BOUNDED_V1_CAPABILITY, capability);
    registerHandler(MSG.FILE_R2_RECORD_DESCRIPTOR, descriptor);
    registerHandler(MSG.FILE_R2_RECORD_RESULT, result);
    registerHandler(MSG.FILE_R2_CAPABILITY, legacyCapability);
    const conn = makeConnection('peer-bounded-v1-valid');

    await handleData(
      {
        type: MSG.FILE_BOUNDED_V1_CAPABILITY,
        bridgeVersion: 1,
        descriptorVersion: 1,
      },
      conn,
    );
    await handleData(descriptorFrame(), conn);
    await handleData(resultFrame(), conn);

    expect(capability).toHaveBeenCalledOnce();
    expect(descriptor).toHaveBeenCalledOnce();
    expect(result).toHaveBeenCalledOnce();
    expect(legacyCapability).not.toHaveBeenCalled();
  });

  it('rejects non-exact top-level frames and invalid versions, sessions, purposes, or outcomes', async () => {
    const capability = vi.fn();
    const descriptor = vi.fn();
    const result = vi.fn();
    registerHandler(MSG.FILE_BOUNDED_V1_CAPABILITY, capability);
    registerHandler(MSG.FILE_R2_RECORD_DESCRIPTOR, descriptor);
    registerHandler(MSG.FILE_R2_RECORD_RESULT, result);
    const conn = makeConnection('peer-bounded-v1-top-level-invalid');

    const validDescriptor = descriptorFrame();
    const validResult = resultFrame();
    for (const frame of [
      { type: MSG.FILE_BOUNDED_V1_CAPABILITY, bridgeVersion: 1, descriptorVersion: 1, extra: 1 },
      { type: MSG.FILE_BOUNDED_V1_CAPABILITY, bridgeVersion: 2, descriptorVersion: 1 },
      { type: MSG.FILE_BOUNDED_V1_CAPABILITY, bridgeVersion: 1, descriptorVersion: 2 },
      { ...validDescriptor, legacySessionId: 0 },
      { ...validDescriptor, legacySessionId: 1.5 },
      { ...validDescriptor, legacySessionId: Number.MAX_SAFE_INTEGER + 1 },
      { ...validDescriptor, purpose: 'next' },
      { ...validDescriptor, descriptorId: '' },
      { ...validDescriptor, descriptorVersion: 2 },
      { ...validDescriptor, unexpected: true },
      { ...validResult, outcome: 'error' },
      { ...validResult, legacySessionId: -1 },
      { ...validResult, descriptorVersion: 2 },
      { ...validResult, unexpected: true },
    ]) {
      await handleData(frame, conn);
    }

    expect(capability).not.toHaveBeenCalled();
    expect(descriptor).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
  });

  it('binds publication identities and record layout to the exact delivery scope', async () => {
    const handler = vi.fn();
    registerHandler(MSG.FILE_R2_RECORD_DESCRIPTOR, handler);
    const conn = makeConnection('peer-bounded-v1-cross-field-invalid');
    const valid = descriptorFrame();
    const base = valid.publication;

    const invalidPublications: unknown[] = [
      { ...base, queueItemId: '00000000-0000-4000-8000-000000000099' },
      { ...base, sourceIdentity: 'source:other' },
      { ...base, transferSessionId: 'binding-other' },
      { ...base, applicationSessionId: 'room-epoch-other' },
      { ...base, storageRoomId: '000001' },
      { ...base, encodedSize: REMOTE_SHARE_MAX_BYTES + 1 },
      { ...base, recordSize: RECORD_SIZE / 2 },
      { ...base, recordCount: 3 },
      {
        ...base,
        cryptoSecretDescriptor: {
          ...base.cryptoSecretDescriptor,
          objectId: base.records[0]!.objectId,
        },
      },
      {
        ...base,
        cryptoSecretDescriptor: {
          ...base.cryptoSecretDescriptor,
          plaintextSize: base.encodedSize - 1,
        },
      },
      {
        ...base,
        cryptoSecretDescriptor: {
          ...base.cryptoSecretDescriptor,
          noncePrefixB64: 'AAAAAAAAAAB=',
        },
      },
      {
        ...base,
        cryptoSecretDescriptor: {
          ...base.cryptoSecretDescriptor,
          keyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB=',
        },
      },
      {
        ...base,
        records: [base.records[0], { ...base.records[1]!, plaintextSize: 122, encryptedSize: 138 }],
      },
      {
        ...base,
        records: [base.records[0], { ...base.records[1]!, objectId: base.records[0]!.objectId }],
      },
      { ...base, expiresAtEpochMs: Date.now() - 1 },
    ];

    for (const candidate of invalidPublications) {
      await handleData({ ...valid, publication: candidate }, conn);
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects non-exact nested scope, secret, record, and array shapes', async () => {
    const handler = vi.fn();
    registerHandler(MSG.FILE_R2_RECORD_DESCRIPTOR, handler);
    const conn = makeConnection('peer-bounded-v1-nested-invalid');
    const valid = descriptorFrame();
    const base = valid.publication;
    const recordsWithExtraProperty = [...base.records] as FileR2RecordPublicationWire['records'] & {
      extra?: boolean;
    };
    recordsWithExtraProperty.extra = true;

    for (const frame of [
      { ...valid, scope: { ...scope, extra: true } },
      {
        ...valid,
        publication: {
          ...base,
          cryptoSecretDescriptor: { ...base.cryptoSecretDescriptor, extra: true },
        },
      },
      {
        ...valid,
        publication: {
          ...base,
          records: [{ ...base.records[0]!, extra: true }, base.records[1]],
        },
      },
      { ...valid, publication: { ...base, records: recordsWithExtraProperty } },
      { ...valid, publication: { ...base, records: [base.records[0]] } },
      { ...valid, publication: { ...base, records: [, base.records[1]] } },
    ]) {
      await handleData(frame, conn);
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not evaluate nested accessors or Proxy get traps while rejecting descriptors', async () => {
    const handler = vi.fn();
    registerHandler(MSG.FILE_R2_RECORD_DESCRIPTOR, handler);
    const conn = makeConnection('peer-bounded-v1-hostile-descriptors');
    const valid = descriptorFrame();
    let accessorReads = 0;
    let proxyReads = 0;

    const accessorPublication = { ...valid.publication };
    Object.defineProperty(accessorPublication, 'records', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return valid.publication.records;
      },
    });
    const proxyPublication = new Proxy(valid.publication, {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    await handleData({ ...valid, publication: accessorPublication }, conn);
    await handleData({ ...valid, publication: proxyPublication }, conn);

    expect(handler).toHaveBeenCalledOnce();
    expect(accessorReads).toBe(0);
    expect(proxyReads).toBe(0);
  });

  it('validates result scope with the same exact bounded identity contract', async () => {
    const handler = vi.fn();
    registerHandler(MSG.FILE_R2_RECORD_RESULT, handler);
    const conn = makeConnection('peer-bounded-v1-result-scope');
    const valid = resultFrame();

    for (const invalidScope of [
      { ...scope, roomEpoch: '' },
      { ...scope, bridgeGeneration: ' bridge ' },
      { ...scope, bindingId: 'x'.repeat(257) },
      { ...scope, queueItemId: 'legacy-index-0' },
      { ...scope, sourceIdentity: '' },
      { ...scope, sourceIdentity: `source:${'x'.repeat(506)}` },
      { ...scope, extra: true },
    ]) {
      await handleData({ ...valid, scope: invalidScope }, conn);
    }

    expect(handler).not.toHaveBeenCalled();

    await handleData({ ...valid, outcome: 'fallback' }, conn);
    expect(handler).toHaveBeenCalledOnce();
  });
});
