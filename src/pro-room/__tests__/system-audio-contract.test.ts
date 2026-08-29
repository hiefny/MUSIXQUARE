import { describe, expect, it } from 'vitest';
import type { ProRoomSystemAudioPublication, ProRoomSystemAudioState } from '../contracts.ts';
import { parseProRoomSystemAudioPublication, parseProRoomSystemAudioState } from '../snapshot.ts';

const OWNER_ID = 'participant_00001';

function publication(): ProRoomSystemAudioPublication {
  return {
    publicationId: 'publication_00001',
    sessionId: 'realtime_session_01',
    track: { trackName: 'audio-stereo', mid: '0' },
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

  it('normalizes the bounded original stereo track label', () => {
    const parsed = parseProRoomSystemAudioPublication({
      ...publication(),
      track: { trackName: ' audio-stereo ', mid: ' 0 ' },
    });
    expect(parsed && 'track' in parsed ? parsed.track : null).toEqual({
      trackName: 'audio-stereo',
      mid: '0',
    });

    expect(
      parseProRoomSystemAudioPublication({
        ...publication(),
        track: { trackName: '', mid: '0' },
      }),
    ).toBeNull();
    expect(
      parseProRoomSystemAudioPublication({
        ...publication(),
        track: { trackName: 'audio-stereo', mid: '' },
      }),
    ).toBeNull();
    expect(
      parseProRoomSystemAudioPublication({
        ...publication(),
        track: { trackName: 'audio-stereo', channel: 'L' },
      }),
    ).toBeNull();
  });

  it('accepts the exact LAN-direct v2 publication and rejects additive ambiguity', () => {
    const direct: ProRoomSystemAudioPublication = {
      publicationId: 'publication_direct_01',
      transport: 'lan-direct',
      protocolVersion: 2,
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
    expect(parseProRoomSystemAudioPublication({ ...direct, protocolVersion: 1 })).toBeNull();
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
