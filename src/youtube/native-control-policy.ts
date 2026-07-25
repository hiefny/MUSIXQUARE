/** Pure routing policy for an iframe-native YouTube play/pause observation. */

export type NativeYouTubeMediaAction = 'play' | 'pause';
type NativeYouTubeControlRoute =
  | 'standard-host'
  | 'standard-controller'
  | 'pro-controller'
  | 'local-pause'
  | 'local-rejoin';

export interface NativeYouTubeControlContext {
  action: NativeYouTubeMediaAction;
  roomKind: 'standard' | 'pro';
  canControlPlayback: boolean;
  hasStandardHostConnection: boolean;
}

export function decideNativeYouTubeControlRoute(
  context: Readonly<NativeYouTubeControlContext>,
): NativeYouTubeControlRoute {
  if (!context.canControlPlayback) {
    return context.action === 'pause' ? 'local-pause' : 'local-rejoin';
  }
  if (context.roomKind === 'pro') return 'pro-controller';
  return context.hasStandardHostConnection ? 'standard-controller' : 'standard-host';
}
