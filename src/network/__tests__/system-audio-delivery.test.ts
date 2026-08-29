import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedPeer } from '../../types/index.ts';
import {
  beginSystemAudioShareDelivery,
  claimGuestDirectSystemAudioRoute,
  endSystemAudioShareDelivery,
  freezeGuestSystemAudioSfuRoute,
  getFrozenSystemAudioSfuAudience,
  getRemainingDirectSystemAudioCapacity,
  getSystemAudioShareDeliverySnapshot,
  isSystemAudioDirectFailurePeer,
  markLocalSystemAudioSfuCapable,
  promoteSystemAudioPeerDeliveryToSfu,
  resetLocalSystemAudioSfuCapabilities,
  resetGuestSystemAudioShareRoute,
  resolveSystemAudioPeerDelivery,
} from '../system-audio-delivery.ts';

function peer(
  id: string,
  connectionType: ConnectedPeer['connectionType'] = 'local',
  open = true,
): ConnectedPeer {
  return {
    id,
    label: id,
    status: 'connected',
    connectionType,
    joinOrder: Number(id.replace(/\D/g, '')) || 1,
    conn: { open, peer: id },
  } as ConnectedPeer;
}

afterEach(() => {
  endSystemAudioShareDelivery();
  resetLocalSystemAudioSfuCapabilities();
  resetGuestSystemAudioShareRoute();
});

describe('bounded system-audio delivery policy', () => {
  it('keeps the original eight LAN guests direct and sends a late ninth capable guest to SFU', () => {
    const initial = Array.from({ length: 8 }, (_, index) => peer(`local-${index + 1}`));
    initial.forEach((item) => markLocalSystemAudioSfuCapable(item.id));
    expect(beginSystemAudioShareDelivery(initial)).toBe('hybrid');
    initial.forEach((item) => expect(resolveSystemAudioPeerDelivery(item)).toBe('direct'));

    const ninth = peer('local-9');
    markLocalSystemAudioSfuCapable(ninth.id);
    expect(resolveSystemAudioPeerDelivery(ninth)).toBe('sfu');
    initial.forEach((item) => expect(resolveSystemAudioPeerDelivery(item)).toBe('direct'));
  });

  it('leaves an incapable late ninth guest unsupported instead of exceeding eight direct calls', () => {
    const initial = Array.from({ length: 8 }, (_, index) => peer(`legacy-base-${index + 1}`));
    beginSystemAudioShareDelivery(initial);

    const lateLegacy = peer('legacy-late-9');
    expect(resolveSystemAudioPeerDelivery(lateLegacy)).toBe('unsupported');
    expect(getSystemAudioShareDeliverySnapshot().directPeerIds).toHaveLength(8);
    expect(getSystemAudioShareDeliverySnapshot().sfuPeerIds).not.toContain(lateLegacy.id);
  });

  it('freezes a 9+ current-client LAN room entirely on SFU at share start', () => {
    const peers = Array.from({ length: 9 }, (_, index) => peer(`all-${index + 1}`));
    peers.forEach((item) => markLocalSystemAudioSfuCapable(item.id));

    expect(beginSystemAudioShareDelivery(peers)).toBe('all-sfu');
    peers.forEach((item) => expect(resolveSystemAudioPeerDelivery(item)).toBe('sfu'));
    expect(getSystemAudioShareDeliverySnapshot().directPeerIds).toHaveLength(0);
  });

  it('uses free direct slots for late legacy guests without moving an all-SFU audience', () => {
    const current = Array.from({ length: 9 }, (_, index) => peer(`sfu-${index + 1}`));
    current.forEach((item) => markLocalSystemAudioSfuCapable(item.id));
    expect(beginSystemAudioShareDelivery(current)).toBe('all-sfu');

    const lateLegacy = Array.from({ length: 9 }, (_, index) => peer(`late-legacy-${index + 1}`));
    lateLegacy.slice(0, 8).forEach((item) => {
      expect(resolveSystemAudioPeerDelivery(item)).toBe('direct');
    });
    expect(resolveSystemAudioPeerDelivery(lateLegacy[8])).toBe('unsupported');

    current.forEach((item) => expect(resolveSystemAudioPeerDelivery(item)).toBe('sfu'));
    const snapshot = getSystemAudioShareDeliverySnapshot();
    expect(snapshot.sfuPeerIds).toHaveLength(9);
    expect(snapshot.directPeerIds).toEqual(lateLegacy.slice(0, 8).map((item) => item.id));
  });

  it('prioritizes legacy LAN clients for eight direct slots and never overflows them', () => {
    const legacy = peer('legacy-1');
    const current = Array.from({ length: 9 }, (_, index) => peer(`current-${index + 1}`));
    current.forEach((item) => markLocalSystemAudioSfuCapable(item.id));

    expect(beginSystemAudioShareDelivery([legacy, ...current])).toBe('hybrid');
    expect(resolveSystemAudioPeerDelivery(legacy)).toBe('direct');
    expect(getSystemAudioShareDeliverySnapshot().directPeerIds).toHaveLength(8);
    expect(getSystemAudioShareDeliverySnapshot().sfuPeerIds).toHaveLength(2);
    expect(getRemainingDirectSystemAudioCapacity(['fallback-a'])).toBe(0);
  });

  it('counts frozen direct routes and unique fallback IDs against one shared cap', () => {
    const direct = Array.from({ length: 6 }, (_, index) => peer(`direct-${index + 1}`));
    beginSystemAudioShareDelivery(direct);

    expect(getRemainingDirectSystemAudioCapacity(['direct-1', 'fallback-a'])).toBe(1);
    expect(getRemainingDirectSystemAudioCapacity(['fallback-a', 'fallback-b'])).toBe(0);
  });

  it('keeps a ninth remote on SFU and never lets a late local route exceed eight direct calls', () => {
    const remote = Array.from({ length: 9 }, (_, index) => peer(`remote-${index + 1}`, 'remote'));
    beginSystemAudioShareDelivery(remote);
    remote.slice(0, 8).forEach((item) => {
      expect(resolveSystemAudioPeerDelivery(item)).toBe('direct');
    });
    expect(resolveSystemAudioPeerDelivery(remote[8])).toBe('sfu');

    const lateLocal = peer('late-local');
    expect(resolveSystemAudioPeerDelivery(lateLocal)).toBe('unsupported');
    const snapshot = getSystemAudioShareDeliverySnapshot();
    expect(snapshot.fallbackDirectPeerIds).toHaveLength(0);
    expect(snapshot.directPeerIds).toHaveLength(8);
    expect(snapshot.sfuPeerIds).toEqual([remote[8].id]);
    expect(getRemainingDirectSystemAudioCapacity()).toBe(0);
  });

  it('does not let a closed stale peer consume a direct slot', () => {
    const stale = peer('stale-1', 'local', false);
    const live = Array.from({ length: 8 }, (_, index) => peer(`live-${index + 1}`));
    beginSystemAudioShareDelivery([stale, ...live]);

    expect(resolveSystemAudioPeerDelivery(stale)).toBe('pending');
    expect(getSystemAudioShareDeliverySnapshot().directPeerIds).toHaveLength(8);
  });

  it('keeps a live direct route frozen when ICE relabels that peer as remote', () => {
    const local = peer('moving-1');
    beginSystemAudioShareDelivery([local]);
    expect(resolveSystemAudioPeerDelivery(local)).toBe('direct');

    const remote = { ...local, connectionType: 'remote' as const };
    expect(resolveSystemAudioPeerDelivery(remote)).toBe('direct');
    expect(getSystemAudioShareDeliverySnapshot().directPeerIds).toContain(local.id);
    expect(getSystemAudioShareDeliverySnapshot().sfuPeerIds).not.toContain(local.id);
  });

  it('promotes a failed warm remote direct route to the SFU without duplicate delivery', () => {
    const remote = peer('failed-direct-remote', 'remote');
    beginSystemAudioShareDelivery([remote]);
    expect(resolveSystemAudioPeerDelivery(remote)).toBe('direct');

    expect(promoteSystemAudioPeerDeliveryToSfu(remote)).toBe(true);
    expect(isSystemAudioDirectFailurePeer(remote.id)).toBe(true);
    expect(resolveSystemAudioPeerDelivery(remote)).toBe('sfu');
    expect(getFrozenSystemAudioSfuAudience(remote.id)).toBe('remote');
    expect(getSystemAudioShareDeliverySnapshot()).toMatchObject({
      directPeerIds: [],
      sfuPeerIds: [remote.id],
    });
  });

  it('rejects a late direct call after explicit failure handoff while preserving ordinary fallback', () => {
    expect(freezeGuestSystemAudioSfuRoute('remote', true)).toBe(true);
    expect(claimGuestDirectSystemAudioRoute()).toBe(false);

    resetGuestSystemAudioShareRoute();
    expect(freezeGuestSystemAudioSfuRoute('remote')).toBe(true);
    expect(claimGuestDirectSystemAudioRoute()).toBe(true);
  });

  it('keeps a live SFU route frozen when ICE relabels that peer as local', () => {
    const remotes = Array.from({ length: 9 }, (_, index) =>
      peer(`moving-sfu-${index + 1}`, 'remote'),
    );
    const remote = remotes[8];
    beginSystemAudioShareDelivery(remotes);
    expect(resolveSystemAudioPeerDelivery(remote)).toBe('sfu');
    expect(getFrozenSystemAudioSfuAudience(remote.id)).toBe('remote');

    const local = { ...remote, connectionType: 'local' as const };
    expect(resolveSystemAudioPeerDelivery(local)).toBe('sfu');
    expect(getFrozenSystemAudioSfuAudience(local.id)).toBe('remote');
    expect(getSystemAudioShareDeliverySnapshot().sfuPeerIds).toContain(remote.id);
    expect(getSystemAudioShareDeliverySnapshot().directPeerIds).not.toContain(remote.id);
  });

  it('keeps an all-audience SFU route frozen when ICE relabels that peer as remote', () => {
    const peers = Array.from({ length: 9 }, (_, index) => peer(`audience-${index + 1}`));
    peers.forEach((item) => markLocalSystemAudioSfuCapable(item.id));
    beginSystemAudioShareDelivery(peers);
    expect(getFrozenSystemAudioSfuAudience(peers[0].id)).toBe('all');

    const relabeled = { ...peers[0], connectionType: 'remote' as const };
    expect(resolveSystemAudioPeerDelivery(relabeled)).toBe('sfu');
    expect(getFrozenSystemAudioSfuAudience(relabeled.id)).toBe('all');
  });

  it('retains capability between shares but clears it for a new transport generation', () => {
    markLocalSystemAudioSfuCapable('same-transport-peer');
    endSystemAudioShareDelivery();
    expect(getSystemAudioShareDeliverySnapshot().capablePeerIds).toContain('same-transport-peer');

    resetLocalSystemAudioSfuCapabilities();
    expect(getSystemAudioShareDeliverySnapshot().capablePeerIds).toEqual([]);
  });
});
