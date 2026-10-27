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
  promoteSystemAudioPeerDeliveryToSfu,
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
  resetGuestSystemAudioShareRoute();
});

// Every LAN guest can consume an all-audience SFU publication (5B-OV2,
// old-version survey OV-B05): the host no longer reads the guests'
// SYSTEM_AUDIO_SFU_CAPABILITY marker, which only told it apart from clients
// below 8.4.38. A LAN guest beyond the eight direct slots, and every late LAN
// guest of an all-SFU share, goes to the SFU with the 'all' audience; nothing
// is 'unsupported'.
describe('bounded system-audio delivery policy', () => {
  it('keeps the original eight LAN guests direct and sends a late ninth guest to SFU', () => {
    const initial = Array.from({ length: 8 }, (_, index) => peer(`local-${index + 1}`));
    expect(beginSystemAudioShareDelivery(initial)).toBe('hybrid');
    initial.forEach((item) => expect(resolveSystemAudioPeerDelivery(item)).toBe('direct'));

    const ninth = peer('local-9');
    expect(resolveSystemAudioPeerDelivery(ninth)).toBe('sfu');
    initial.forEach((item) => expect(resolveSystemAudioPeerDelivery(item)).toBe('direct'));
  });

  it('gives late LAN guests a free direct slot first, then the SFU with the all audience, never a ninth direct call (5B-OV2)', () => {
    const initial = Array.from({ length: 7 }, (_, index) => peer(`base-${index + 1}`));
    expect(beginSystemAudioShareDelivery(initial)).toBe('hybrid');

    const late = [peer('late-8'), peer('late-9'), peer('late-10')];
    expect(resolveSystemAudioPeerDelivery(late[0])).toBe('direct');
    expect(resolveSystemAudioPeerDelivery(late[1])).toBe('sfu');
    expect(resolveSystemAudioPeerDelivery(late[2])).toBe('sfu');
    expect(getFrozenSystemAudioSfuAudience(late[1].id)).toBe('all');
    expect(getFrozenSystemAudioSfuAudience(late[2].id)).toBe('all');
    const snapshot = getSystemAudioShareDeliverySnapshot();
    expect(snapshot.directPeerIds).toHaveLength(8);
    expect(snapshot.sfuPeerIds).toEqual([late[1].id, late[2].id]);
  });

  it('freezes a 9+ LAN room entirely on SFU at share start', () => {
    const peers = Array.from({ length: 9 }, (_, index) => peer(`all-${index + 1}`));

    expect(beginSystemAudioShareDelivery(peers)).toBe('all-sfu');
    peers.forEach((item) => {
      expect(resolveSystemAudioPeerDelivery(item)).toBe('sfu');
      expect(getFrozenSystemAudioSfuAudience(item.id)).toBe('all');
    });
    expect(getSystemAudioShareDeliverySnapshot().directPeerIds).toHaveLength(0);
  });

  it('sends late LAN guests of an all-SFU share to the SFU too, leaving the direct slots free (5B-OV2)', () => {
    const initial = Array.from({ length: 9 }, (_, index) => peer(`sfu-${index + 1}`));
    expect(beginSystemAudioShareDelivery(initial)).toBe('all-sfu');

    const late = Array.from({ length: 9 }, (_, index) => peer(`late-${index + 1}`));
    late.forEach((item) => {
      expect(resolveSystemAudioPeerDelivery(item)).toBe('sfu');
      expect(getFrozenSystemAudioSfuAudience(item.id)).toBe('all');
    });

    initial.forEach((item) => expect(resolveSystemAudioPeerDelivery(item)).toBe('sfu'));
    const snapshot = getSystemAudioShareDeliverySnapshot();
    expect(snapshot.sfuPeerIds).toHaveLength(18);
    expect(snapshot.directPeerIds).toEqual([]);
    expect(getRemainingDirectSystemAudioCapacity()).toBe(8);
  });

  it('never overflows the eight direct slots: ten LAN guests start on the SFU and leave the direct budget to fallbacks (5B-OV2)', () => {
    const lan = Array.from({ length: 10 }, (_, index) => peer(`lan-${index + 1}`));

    expect(beginSystemAudioShareDelivery(lan)).toBe('all-sfu');
    const snapshot = getSystemAudioShareDeliverySnapshot();
    expect(snapshot.directPeerIds).toEqual([]);
    expect(snapshot.sfuPeerIds).toHaveLength(10);
    expect(getRemainingDirectSystemAudioCapacity(['fallback-a'])).toBe(7);
  });

  it('gives a hybrid share the direct slots to its LAN guests in join order, then to remote guests, and sends remote overflow to the SFU', () => {
    const lan = [peer('lan-3'), peer('lan-1'), peer('lan-2')];
    const remote = Array.from({ length: 7 }, (_, index) => peer(`rmt-${index + 4}`, 'remote'));

    expect(beginSystemAudioShareDelivery([lan[0], ...remote, lan[1], lan[2]])).toBe('hybrid');
    const snapshot = getSystemAudioShareDeliverySnapshot();
    expect(snapshot.directPeerIds).toEqual([
      'lan-1',
      'lan-2',
      'lan-3',
      ...remote.slice(0, 5).map((item) => item.id),
    ]);
    expect(snapshot.sfuPeerIds).toEqual(remote.slice(5).map((item) => item.id));
    expect(snapshot.sfuAudiences).toEqual({ 'rmt-9': 'remote', 'rmt-10': 'remote' });
  });

  it('counts frozen direct routes and unique fallback IDs against one shared cap', () => {
    const direct = Array.from({ length: 6 }, (_, index) => peer(`direct-${index + 1}`));
    beginSystemAudioShareDelivery(direct);

    expect(getRemainingDirectSystemAudioCapacity(['direct-1', 'fallback-a'])).toBe(1);
    expect(getRemainingDirectSystemAudioCapacity(['fallback-a', 'fallback-b'])).toBe(0);
  });

  it('keeps a ninth remote on SFU and sends a late LAN guest to the SFU, never past eight direct calls (5B-OV2)', () => {
    const remote = Array.from({ length: 9 }, (_, index) => peer(`remote-${index + 1}`, 'remote'));
    beginSystemAudioShareDelivery(remote);
    remote.slice(0, 8).forEach((item) => {
      expect(resolveSystemAudioPeerDelivery(item)).toBe('direct');
    });
    expect(resolveSystemAudioPeerDelivery(remote[8])).toBe('sfu');

    const lateLocal = peer('late-local');
    expect(resolveSystemAudioPeerDelivery(lateLocal)).toBe('sfu');
    expect(getFrozenSystemAudioSfuAudience(lateLocal.id)).toBe('all');
    const snapshot = getSystemAudioShareDeliverySnapshot();
    expect(snapshot.fallbackDirectPeerIds).toHaveLength(0);
    expect(snapshot.directPeerIds).toHaveLength(8);
    expect(snapshot.sfuPeerIds).toEqual([remote[8].id, lateLocal.id]);
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

  it('promotes a failed warm LAN direct route to the SFU with the all audience (5B-OV2)', () => {
    const local = peer('failed-direct-local');
    beginSystemAudioShareDelivery([local]);
    expect(resolveSystemAudioPeerDelivery(local)).toBe('direct');

    expect(promoteSystemAudioPeerDeliveryToSfu(local)).toBe(true);
    expect(isSystemAudioDirectFailurePeer(local.id)).toBe(true);
    expect(resolveSystemAudioPeerDelivery(local)).toBe('sfu');
    expect(getFrozenSystemAudioSfuAudience(local.id)).toBe('all');
    expect(getSystemAudioShareDeliverySnapshot()).toMatchObject({
      directPeerIds: [],
      sfuPeerIds: [local.id],
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
    beginSystemAudioShareDelivery(peers);
    expect(getFrozenSystemAudioSfuAudience(peers[0].id)).toBe('all');

    const relabeled = { ...peers[0], connectionType: 'remote' as const };
    expect(resolveSystemAudioPeerDelivery(relabeled)).toBe('sfu');
    expect(getFrozenSystemAudioSfuAudience(relabeled.id)).toBe('all');
  });
});
