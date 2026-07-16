/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import {
  freezeFileDeliveryMode,
  getDirectFilePeers,
  getR2FileTargets,
  getUnsupportedFileTargetsForTests,
  isGuestR2FileDelivery,
  isLocalFileR2CapableForTests,
  markLocalFileR2Capable,
  markLateLocalPeerForR2,
  recordGuestFileDelivery,
  releaseFileDeliveryPeer,
  resolvePeerFileDelivery,
  resetFileDeliveryPolicies,
} from '../file-delivery-policy.ts';

const Q0 = '00000000-0000-4000-8000-000000000001';

function peer(index: number, connectionType: 'local' | 'remote' | 'unknown'): ConnectedPeer {
  const id = `peer-${index}`;
  return {
    id,
    slot: index,
    label: `Peer ${index}`,
    conn: { open: true, peer: id } as DataConnection,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: connectionType === 'local',
    joinOrder: index,
    connectionType,
    lastHeartbeat: Date.now(),
  };
}

beforeEach(() => {
  resetState();
  resetFileDeliveryPolicies();
  setState('network.sessionCode', '123456');
});

describe('bounded local file delivery policy', () => {
  it('keeps exactly eight local guests on direct P2P', () => {
    setState(
      'network.connectedPeers',
      Array.from({ length: 8 }, (_, index) => peer(index + 1, 'local')),
    );

    expect(freezeFileDeliveryMode(1)).toBe('direct-local');
    expect(getDirectFilePeers(1)).toHaveLength(8);
    expect(getR2FileTargets(1)).toHaveLength(0);
  });

  it('routes every guest through R2 when nine capable local guests start together', () => {
    const peers = Array.from({ length: 9 }, (_, index) => peer(index + 1, 'local'));
    for (const item of peers) markLocalFileR2Capable(item.id);
    setState('network.connectedPeers', peers);

    expect(freezeFileDeliveryMode(2)).toBe('r2-fanout');
    expect(getDirectFilePeers(2)).toHaveLength(0);
    expect(getR2FileTargets(2)).toHaveLength(9);
    expect(getUnsupportedFileTargetsForTests(2)).toHaveLength(0);
  });

  it('prioritizes legacy guests for at most eight direct slots in a mixed room', () => {
    const legacy = Array.from({ length: 10 }, (_, index) => peer(index + 1, 'local'));
    const capable = peer(11, 'local');
    markLocalFileR2Capable(capable.id);
    setState('network.connectedPeers', [...legacy, capable]);

    expect(freezeFileDeliveryMode(3)).toBe('mixed');
    expect(getDirectFilePeers(3).map((item) => item.id)).toEqual(
      legacy.slice(0, 8).map((item) => item.id),
    );
    expect(getR2FileTargets(3).map((conn) => conn.peer)).toEqual([capable.id]);
    expect(getUnsupportedFileTargetsForTests(3).map((conn) => conn.peer)).toEqual(
      legacy.slice(8).map((item) => item.id),
    );
  });

  it('keeps an in-flight direct snapshot and offloads only the ninth newcomer', () => {
    const firstEight = Array.from({ length: 8 }, (_, index) => peer(index + 1, 'local'));
    setState('network.connectedPeers', firstEight);
    setState('transfer.currentSessionId', 4);
    expect(freezeFileDeliveryMode(4)).toBe('direct-local');

    const ninth = peer(9, 'local');
    markLocalFileR2Capable(ninth.id);
    setState('network.connectedPeers', [...firstEight, ninth]);
    markLateLocalPeerForR2(ninth.id);

    expect(getDirectFilePeers(4).map((item) => item.id)).toEqual(firstEight.map((item) => item.id));
    expect(getR2FileTargets(4).map((conn) => conn.peer)).toEqual([ninth.id]);

    // The next transfer takes a fresh room snapshot and moves everyone.
    expect(freezeFileDeliveryMode(5)).toBe('mixed');
    expect(getDirectFilePeers(5)).toHaveLength(8);
    expect(getR2FileTargets(5).map((conn) => conn.peer)).toEqual([ninth.id]);
  });

  it('keeps capable late peers on R2 and reserves free mixed-mode direct slots for legacy peers', () => {
    const legacy = peer(1, 'local');
    const capable = Array.from({ length: 8 }, (_, index) => peer(index + 2, 'local'));
    for (const item of capable) markLocalFileR2Capable(item.id);
    setState('network.connectedPeers', [legacy, ...capable]);

    expect(freezeFileDeliveryMode(51)).toBe('mixed');
    expect(getDirectFilePeers(51).map((item) => item.id)).toEqual([legacy.id]);

    const lateCapable = peer(10, 'local');
    markLocalFileR2Capable(lateCapable.id);
    setState('network.connectedPeers', [legacy, ...capable, lateCapable]);
    expect(resolvePeerFileDelivery(lateCapable, 51)).toBe('r2');
    expect(getDirectFilePeers(51).map((item) => item.id)).toEqual([legacy.id]);

    const lateLegacy = peer(11, 'local');
    setState('network.connectedPeers', [legacy, ...capable, lateCapable, lateLegacy]);
    expect(resolvePeerFileDelivery(lateLegacy, 51)).toBe('direct-local');
    expect(getDirectFilePeers(51).map((item) => item.id)).toEqual([legacy.id, lateLegacy.id]);
  });

  it('recovers only an unsupported overflow peer when capability arrives late', () => {
    const peers = Array.from({ length: 9 }, (_, index) => peer(index + 1, 'local'));
    setState('network.connectedPeers', peers);

    expect(freezeFileDeliveryMode(6)).toBe('mixed');
    expect(getDirectFilePeers(6)).toHaveLength(8);
    expect(getUnsupportedFileTargetsForTests(6).map((conn) => conn.peer)).toEqual(['peer-9']);

    expect(markLocalFileR2Capable('peer-9')).toEqual([6]);
    expect(getDirectFilePeers(6)).toHaveLength(8);
    expect(getR2FileTargets(6).map((conn) => conn.peer)).toEqual(['peer-9']);
    expect(getUnsupportedFileTargetsForTests(6)).toHaveLength(0);
  });

  it('gives an all-R2 session up to eight bounded direct slots for late legacy guests', () => {
    const initial = Array.from({ length: 9 }, (_, index) => peer(index + 1, 'local'));
    for (const item of initial) markLocalFileR2Capable(item.id);
    setState('network.connectedPeers', initial);
    setState('transfer.currentSessionId', 7);
    expect(freezeFileDeliveryMode(7)).toBe('r2-fanout');

    const lateLegacy = Array.from({ length: 9 }, (_, index) => peer(index + 10, 'local'));
    setState('network.connectedPeers', [...initial, ...lateLegacy]);
    for (const item of lateLegacy) markLateLocalPeerForR2(item.id);

    expect(getR2FileTargets(7)).toHaveLength(9);
    expect(getDirectFilePeers(7).map((item) => item.id)).toEqual(
      lateLegacy.slice(0, 8).map((item) => item.id),
    );
    expect(getUnsupportedFileTargetsForTests(7).map((conn) => conn.peer)).toEqual([
      lateLegacy[8]!.id,
    ]);
  });

  it('preserves the existing R2 route for remote guests in a small room', () => {
    setState('network.connectedPeers', [peer(1, 'local'), peer(2, 'remote')]);

    expect(freezeFileDeliveryMode(8)).toBe('direct-local');
    expect(getDirectFilePeers(8).map((item) => item.id)).toEqual(['peer-1']);
    expect(getR2FileTargets(8).map((conn) => conn.peer)).toEqual(['peer-2']);
  });

  it('keeps a frozen direct peer send-eligible after remote ICE relabeling', async () => {
    const local = peer(1, 'local');
    setState('network.connectedPeers', [local]);
    expect(freezeFileDeliveryMode(81)).toBe('direct-local');
    expect(resolvePeerFileDelivery(local, 81)).toBe('direct-local');

    const relabeled = { ...local, connectionType: 'remote' as const, isDataTarget: false };
    setState('network.connectedPeers', [relabeled]);
    expect(resolvePeerFileDelivery(relabeled, 81)).toBe('direct-local');
    expect(getR2FileTargets(81)).toHaveLength(0);
    expect(getDirectFilePeers(81).map((item) => item.id)).toEqual([relabeled.id]);
    const { canSendFileTo } = await import('../../network/peer-state.ts');
    expect(await canSendFileTo(relabeled.conn as DataConnection, 81)).toBe(true);
  });

  it('keeps unknown peers pending and freezes only a confirmed remote R2 route', () => {
    const capableUnknown = peer(1, 'unknown');
    const legacyUnknown = peer(2, 'unknown');
    const remote = peer(3, 'remote');
    markLocalFileR2Capable(capableUnknown.id);
    setState('network.connectedPeers', [capableUnknown, legacyUnknown, remote]);

    expect(resolvePeerFileDelivery(capableUnknown, 9)).toBe('pending');
    expect(resolvePeerFileDelivery(legacyUnknown, 9)).toBe('pending');
    expect(resolvePeerFileDelivery(remote, 9)).toBe('r2');
    expect(getUnsupportedFileTargetsForTests(9)).toHaveLength(0);

    const capableLocal = {
      ...capableUnknown,
      connectionType: 'local' as const,
      isDataTarget: true,
    };
    const legacyLocal = { ...legacyUnknown, connectionType: 'local' as const, isDataTarget: true };
    const remoteNowLocal = { ...remote, connectionType: 'local' as const, isDataTarget: true };
    setState('network.connectedPeers', [capableLocal, legacyLocal, remoteNowLocal]);

    expect(resolvePeerFileDelivery(capableLocal, 9)).toBe('direct-local');
    expect(resolvePeerFileDelivery(legacyLocal, 9)).toBe('direct-local');
    expect(resolvePeerFileDelivery(remoteNowLocal, 9)).toBe('r2');

    expect(markLocalFileR2Capable(legacyLocal.id)).toEqual([]);
    expect(resolvePeerFileDelivery(legacyLocal, 9)).toBe('direct-local');
  });

  it('resolves unknown capable and legacy overflow only after local ICE evaluation', () => {
    const direct = Array.from({ length: 8 }, (_, index) => peer(index + 1, 'local'));
    setState('network.connectedPeers', direct);
    expect(freezeFileDeliveryMode(91)).toBe('direct-local');

    const capableUnknown = peer(9, 'unknown');
    const legacyUnknown = peer(10, 'unknown');
    setState('network.connectedPeers', [...direct, capableUnknown, legacyUnknown]);
    markLocalFileR2Capable(capableUnknown.id);
    expect(resolvePeerFileDelivery(capableUnknown, 91)).toBe('pending');
    expect(resolvePeerFileDelivery(legacyUnknown, 91)).toBe('pending');
    expect(getUnsupportedFileTargetsForTests(91)).toHaveLength(0);

    const capableLocal = {
      ...capableUnknown,
      connectionType: 'local' as const,
      isDataTarget: true,
    };
    const legacyLocal = { ...legacyUnknown, connectionType: 'local' as const, isDataTarget: true };
    setState('network.connectedPeers', [...direct, capableLocal, legacyLocal]);
    expect(resolvePeerFileDelivery(capableLocal, 91)).toBe('r2');
    expect(resolvePeerFileDelivery(legacyLocal, 91)).toBe('unsupported');

    expect(markLocalFileR2Capable(legacyLocal.id)).toEqual([91]);
    expect(resolvePeerFileDelivery(legacyLocal, 91)).toBe('r2');
  });

  it('drops connection-bound capability and route assignments before reconnect', () => {
    const firstConnection = peer(1, 'remote');
    markLocalFileR2Capable(firstConnection.id);
    setState('network.connectedPeers', [firstConnection]);
    expect(resolvePeerFileDelivery(firstConnection, 10)).toBe('r2');

    releaseFileDeliveryPeer(firstConnection.id);
    expect(isLocalFileR2CapableForTests(firstConnection.id)).toBe(false);

    const reconnected = {
      ...firstConnection,
      conn: { open: true, peer: firstConnection.id } as DataConnection,
      connectionType: 'local' as const,
      isDataTarget: true,
    };
    setState('network.connectedPeers', [reconnected]);
    expect(resolvePeerFileDelivery(reconnected, 10)).toBe('direct-local');
    expect(getR2FileTargets(10)).toHaveLength(0);
  });

  it('never prunes an active frozen session while trimming old policy history', () => {
    const local = peer(1, 'local');
    setState('network.connectedPeers', [local]);
    setState('transfer.currentSessionId', 101);
    expect(freezeFileDeliveryMode(101)).toBe('direct-local');

    for (let sessionId = 102; sessionId <= 166; sessionId += 1) {
      freezeFileDeliveryMode(sessionId);
    }

    const relabeled = { ...local, connectionType: 'remote' as const, isDataTarget: false };
    setState('network.connectedPeers', [relabeled]);
    expect(resolvePeerFileDelivery(relabeled, 101)).toBe('direct-local');
  });

  it('tracks a guest R2 marker by stable queue and transfer session', () => {
    recordGuestFileDelivery(Q0, 7, 'r2');
    expect(isGuestR2FileDelivery(Q0, 7)).toBe(true);
    expect(isGuestR2FileDelivery(Q0, 8)).toBe(false);

    recordGuestFileDelivery(Q0, 8, 'direct-local');
    expect(isGuestR2FileDelivery(Q0)).toBe(false);
    // An older delayed marker cannot replace the newer direct owner.
    recordGuestFileDelivery(Q0, 7, 'r2');
    expect(isGuestR2FileDelivery(Q0)).toBe(false);
  });
});
