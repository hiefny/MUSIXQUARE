import { describe, expect, it } from 'vitest';
import type { ProRoomSystemAudioPublication, ProRoomSystemAudioState } from '../contracts.ts';
import { parseProRoomSystemAudioPublication, parseProRoomSystemAudioState } from '../snapshot.ts';

const OWNER_ID = 'participant_00001';

function publication(): ProRoomSystemAudioPublication {
  return {
    publicationId: 'publication_00001',
    sessionId: 'realtime_session_01',
    tracks: [
      { trackName: 'audio-L', channel: 'L' as const, mid: '0' },
      { trackName: 'audio-R', channel: 'R' as const, mid: '1' },
    ],
  };
}

function liveState(): ProRoomSystemAudioState {
  return {
    generation: 7,
    status: 'live',
    ownerParticipantId: OWNER_ID,
    claimExpiresAt: null,
    liveExpiresAt: 1_900_000_000_000,
    publication: publication(),
  };
}

describe('PRO system-audio wire contract', () => {
  it('accepts the exact idle, preparing, and live discriminated states', () => {
    const idle: ProRoomSystemAudioState = {
      generation: 0,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    };
    const preparing: ProRoomSystemAudioState = {
      generation: 1,
      status: 'preparing',
      ownerParticipantId: OWNER_ID,
      claimExpiresAt: 1_800_000_045_000,
      liveExpiresAt: null,
      publication: null,
    };
    expect(parseProRoomSystemAudioState(idle)).toEqual(idle);
    expect(parseProRoomSystemAudioState(preparing)).toEqual(preparing);
    expect(parseProRoomSystemAudioState(liveState())).toEqual(liveState());
  });

  it('normalizes bounded track labels while requiring one unique L and R track', () => {
    const parsed = parseProRoomSystemAudioPublication({
      ...publication(),
      tracks: [
        { trackName: ' audio-L ', channel: 'L', mid: ' 0 ' },
        { trackName: ' audio-R ', channel: 'R', mid: ' 1 ' },
      ],
    });
    expect(parsed && 'tracks' in parsed ? parsed.tracks : null).toEqual([
      { trackName: 'audio-L', channel: 'L', mid: '0' },
      { trackName: 'audio-R', channel: 'R', mid: '1' },
    ]);

    expect(
      parseProRoomSystemAudioPublication({
        ...publication(),
        tracks: [
          { trackName: 'audio-L', channel: 'L', mid: '0' },
          { trackName: 'audio-R', channel: 'L', mid: '1' },
        ],
      }),
    ).toBeNull();
    expect(
      parseProRoomSystemAudioPublication({
        ...publication(),
        tracks: [
          { trackName: 'same', channel: 'L', mid: '0' },
          { trackName: 'same', channel: 'R', mid: '1' },
        ],
      }),
    ).toBeNull();
    expect(
      parseProRoomSystemAudioPublication({
        ...publication(),
        tracks: [
          { trackName: 'audio-L', channel: 'L', mid: '0' },
          { trackName: 'audio-R', channel: 'R', mid: '0' },
        ],
      }),
    ).toBeNull();
  });

  it('accepts the exact LAN-direct v1 publication and rejects additive ambiguity', () => {
    const direct: ProRoomSystemAudioPublication = {
      publicationId: 'publication_direct_01',
      transport: 'lan-direct',
      protocolVersion: 1,
    };
    expect(parseProRoomSystemAudioPublication(direct)).toEqual(direct);
    expect(
      parseProRoomSystemAudioState({
        ...liveState(),
        publication: direct,
      }),
    ).toEqual({ ...liveState(), publication: direct });
    expect(
      parseProRoomSystemAudioPublication({ ...direct, sessionId: 'not-a-direct-field' }),
    ).toBeNull();
    expect(parseProRoomSystemAudioPublication({ ...direct, protocolVersion: 2 })).toBeNull();
  });

  it('rejects malformed lifecycle combinations and every private or unknown field', () => {
    expect(
      parseProRoomSystemAudioState({
        ...liveState(),
        claimExpiresAt: 1_800_000_000_000,
      }),
    ).toBeNull();
    expect(
      parseProRoomSystemAudioState({
        ...liveState(),
        publication: null,
      }),
    ).toBeNull();
    expect(
      parseProRoomSystemAudioState({
        ...liveState(),
        leaseId: 'never-public',
      }),
    ).toBeNull();
    expect(
      parseProRoomSystemAudioState({
        ...liveState(),
        ownerPresenceIncarnationId: 'never-public',
      }),
    ).toBeNull();
    expect(
      parseProRoomSystemAudioPublication({
        ...publication(),
        sessionOwnerToken: 'never-public',
      }),
    ).toBeNull();
  });
});
