// The guided demo host's pending shared start. It is kept apart from the demo
// timing projection (playback-timing.ts) because the late-join PONG in
// network/sync.ts reads it from the startup graph, while the projection and
// its writer (demo/mode.ts) stay in the lazy demo runtime.
let demoHostStartAt: number | null = null;

export function setDemoHostStartAt(timestamp: number | null): void {
  demoHostStartAt = timestamp !== null && Number.isFinite(timestamp) ? timestamp : null;
}

/** Published by the exact host output owner; load, pause and exit revoke it. */
export function getPendingDemoHostStartAt(): number | undefined {
  return demoHostStartAt !== null && demoHostStartAt > Date.now() ? demoHostStartAt : undefined;
}
