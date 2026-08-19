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
unlinkSync('scripts/one-shot-signaling-liveness-patch-base.mjs');

console.log('Bound browser offline/online recovery to the network initialization lifecycle.');
