import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

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
