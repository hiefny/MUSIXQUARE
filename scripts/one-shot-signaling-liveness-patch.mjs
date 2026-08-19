import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const basePath = 'scripts/one-shot-signaling-liveness-patch-base.mjs';
let baseSource = readFileSync(basePath, 'utf8');

const nestedTimerTemplate =
  'timerKey: `signaling-liveness-${this.monitorId}-${++this.nextSocketId}`,';
const timerConcatenation =
  "timerKey: 'signaling-liveness-' + this.monitorId + '-' + ++this.nextSocketId,";
if (!baseSource.includes(nestedTimerTemplate)) {
  throw new Error('Base generator: nested timer template anchor not found');
}
baseSource = baseSource.replace(nestedTimerTemplate, timerConcatenation);

// The old prototype attempted to modify the repository CI and release-evidence
// contracts even though the final candidate restores both from main. Remove
// those generator blocks before parsing so the product repair stays scoped and
// nested template literals inside the discarded code cannot break Node parsing.
const ciPatchStart = baseSource.indexOf("replaceOnce(\n  '.github/workflows/ci.yml'");
const cachePatchStart = baseSource.indexOf(
  "replaceOnce(\n  'scripts/service-worker-asset.ts'",
  ciPatchStart,
);
if (ciPatchStart < 0 || cachePatchStart < 0 || cachePatchStart <= ciPatchStart) {
  throw new Error('Base generator: CI/release patch range not found');
}
baseSource = baseSource.slice(0, ciPatchStart) + baseSource.slice(cachePatchStart);
writeFileSync(basePath, baseSource, 'utf8');

await import('./one-shot-signaling-liveness-patch-base.mjs');

const path = 'src/network/peer.ts';
const source = readFileSync(path, 'utf8');
const before = `async function initNetwork(requestedId: string | null = null): Promise<string> {
  // Client feature advertisements are authenticated by the exact live data
`;
const after = `async function initNetwork(requestedId: string | null = null): Promise<string> {
  bindBrowserConnectivityRecovery();
  // Client feature advertisements are authenticated by the exact live data
`;
const count = source.split(before).length - 1;
if (count !== 1) {
  throw new Error(`src/network/peer.ts: expected one browser recovery binding anchor, found ${count}`);
}
writeFileSync(path, source.replace(before, after), 'utf8');

for (const transientPath of [
  'scripts/one-shot-signaling-liveness-patch-base.mjs',
  '.github/workflows/agent-signaling-liveness.yml',
  'scripts/one-shot-signaling-liveness-patch.mjs',
]) {
  unlinkSync(transientPath);
}

console.log('Applied exact WebSocket liveness and removed all temporary automation sources.');
