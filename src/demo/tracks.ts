export interface DemoTrack {
  id: string;
  number: number;
  title: string;
  shortTitle: string;
  artist: string;
  fileName: string;
  mime: string;
  url: string;
  infoUrl: string;
}

const LINELIGHT_INFO_URL = 'https://batzerk.bandcamp.com/album/linelight-ost';

export const DEMO_TRACKS: DemoTrack[] = [
  {
    id: 'linelight-adventure',
    number: 1,
    title: 'Linelight OST - Adventure',
    shortTitle: 'Adventure',
    artist: 'Brett Taylor',
    fileName: 'Brett Taylor - Linelight OST - 01 Adventure.m4a',
    mime: 'audio/mp4',
    url: 'https://demo.musixquare.com/linelight/01-adventure.m4a',
    infoUrl: LINELIGHT_INFO_URL,
  },
  {
    id: 'linelight-lockstep-lunge',
    number: 2,
    title: 'Linelight OST - Lockstep Lunge',
    shortTitle: 'Lockstep Lunge',
    artist: 'Brett Taylor',
    fileName: 'Brett Taylor - Linelight OST - 02 Lockstep Lunge.m4a',
    mime: 'audio/mp4',
    url: 'https://demo.musixquare.com/linelight/02-lockstep-lunge.m4a',
    infoUrl: LINELIGHT_INFO_URL,
  },
  {
    id: 'linelight-forgiveness-ballad',
    number: 3,
    title: 'Linelight OST - Forgiveness Ballad',
    shortTitle: 'Forgiveness Ballad',
    artist: 'Brett Taylor',
    fileName: 'Brett Taylor - Linelight OST - 03 Forgiveness Ballad.m4a',
    mime: 'audio/mp4',
    url: 'https://demo.musixquare.com/linelight/03-forgiveness-ballad.m4a',
    infoUrl: LINELIGHT_INFO_URL,
  },
  {
    id: 'linelight-spring',
    number: 4,
    title: 'Linelight OST - Spring',
    shortTitle: 'Spring',
    artist: 'Brett Taylor',
    fileName: 'Brett Taylor - Linelight OST - 04 Spring.m4a',
    mime: 'audio/mp4',
    url: 'https://demo.musixquare.com/linelight/04-spring.m4a',
    infoUrl: LINELIGHT_INFO_URL,
  },
];

export const DEMO_TRACK = DEMO_TRACKS[0];

export function getNextDemoTrackIndex(index: number): number {
  return (index + 1) % DEMO_TRACKS.length;
}

export function getDemoTrackByIndex(index: number): DemoTrack {
  return DEMO_TRACKS[index] ?? DEMO_TRACK;
}

export function createDemoTrackMeta(track: DemoTrack = DEMO_TRACK): {
  type: 'file';
  name: string;
  title: string;
  artist: string;
  videoId: null;
  playlistId: null;
} {
  return {
    type: 'file',
    name: track.fileName,
    title: track.title,
    artist: track.artist,
    videoId: null,
    playlistId: null,
  };
}
