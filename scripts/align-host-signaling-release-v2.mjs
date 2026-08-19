import { readFileSync, writeFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function write(path, content) {
  writeFileSync(path, content, 'utf8');
}

function replaceOnce(path, before, after, label = before.slice(0, 100)) {
  const source = read(path);
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${path}: expected one ${label} anchor, found ${count}`);
  }
  write(path, source.replace(before, after));
}

function replaceRegexOnce(path, pattern, replacement, label) {
  const source = read(path);
  const matchPattern = pattern.global
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);
  const matches = [...source.matchAll(matchPattern)];
  if (matches.length !== 1) {
    throw new Error(`${path}: expected one ${label} match, found ${matches.length}`);
  }
  write(path, source.replace(pattern, replacement));
}

for (const name of ['package.json', 'package-lock.json']) {
  const document = JSON.parse(read(name));
  if (document.version !== '8.3.72') {
    throw new Error(`${name}: expected version 8.3.72, found ${document.version}`);
  }
  document.version = '8.3.73';
  if (name === 'package-lock.json') {
    const root = document.packages?.[''];
    if (!root || root.version !== '8.3.72') {
      throw new Error('package-lock.json: unexpected root version');
    }
    root.version = '8.3.73';
  }
  write(name, `${JSON.stringify(document, null, 2)}\n`);
}

for (const [path, constant] of [
  ['cloudflare/app-worker.ts', 'ADMIN_ASSET_VERSION'],
  ['browser/classic-runtime/admin.ts', 'ADMIN_SCRIPT_VERSION'],
]) {
  replaceRegexOnce(
    path,
    new RegExp(`const ${constant} = '8\\.3\\.72';`),
    `const ${constant} = '8.3.73';`,
    constant,
  );
}

const appWorkerCorsTestPath = 'src/core/__tests__/app-worker-cors.test.ts';
let appWorkerCorsTests = read(appWorkerCorsTestPath);
const adminAssetVersionExpectation = '8.3.72';
const adminAssetVersionExpectationCount =
  appWorkerCorsTests.split(adminAssetVersionExpectation).length - 1;
if (adminAssetVersionExpectationCount !== 7) {
  throw new Error(
    `${appWorkerCorsTestPath}: expected seven admin asset version expectations, found ${adminAssetVersionExpectationCount}`,
  );
}
appWorkerCorsTests = appWorkerCorsTests.replaceAll(adminAssetVersionExpectation, '8.3.73');
write(appWorkerCorsTestPath, appWorkerCorsTests);

const workerTestPath = 'src/network/transport/__tests__/cloudflare-signaling-worker.test.ts';
let workerTests = read(workerTestPath);

function replaceWorkerTestOnce(before, after, label) {
  const count = workerTests.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${workerTestPath}: expected one ${label} anchor, found ${count}`);
  }
  workerTests = workerTests.replace(before, after);
}

const workerVersionExpectation = `      workerVersionId: 'worker-version-123',
`;
const workerVersionWithLiveness = `      workerVersionId: 'worker-version-123',
      signalingLivenessVersion: 1,
`;
const metadataExpectationCount = workerTests.split(workerVersionExpectation).length - 1;
if (metadataExpectationCount !== 2) {
  throw new Error(`${workerTestPath}: expected two Worker metadata expectations, found ${metadataExpectationCount}`);
}
workerTests = workerTests.replaceAll(workerVersionExpectation, workerVersionWithLiveness);
const compatibilityExpectations = `    expect(sent(host)[0]).not.toHaveProperty('workerVersionId');
    expect(sent(guest)[0]).not.toHaveProperty('workerVersionId');
`;
const compatibilityWithLiveness = `    expect(sent(host)[0]).not.toHaveProperty('workerVersionId');
    expect(sent(guest)[0]).not.toHaveProperty('workerVersionId');
    expect(sent(host)[0]).not.toHaveProperty('signalingLivenessVersion');
    expect(sent(guest)[0]).not.toHaveProperty('signalingLivenessVersion');
`;
if (!workerTests.includes(compatibilityExpectations)) {
  throw new Error(`${workerTestPath}: compatibility expectation block not found`);
}
workerTests = workerTests.replace(compatibilityExpectations, compatibilityWithLiveness);

const hostReleaseExpectation = 'hostReleaseAt: Date.now() + 60_000';
const hostReleaseExpectationCount = workerTests.split(hostReleaseExpectation).length - 1;
if (hostReleaseExpectationCount < 1) {
  throw new Error(`${workerTestPath}: host reclaim expectations not found`);
}
workerTests = workerTests.replaceAll(hostReleaseExpectation, 'hostReleaseAt: Date.now() + 120_000');

replaceWorkerTestOnce(
  `    expect(state.storage.alarmTime).toBe(released.hostReleaseAt);

    vi.advanceTimersByTime(60_000);
    await room.alarm();
`,
  `    expect(state.storage.alarmTime).toBe(released.hostReleaseAt);

    vi.advanceTimersByTime(120_000);
    await room.alarm();
`,
  'maintenance host reclaim alarm advance',
);

replaceWorkerTestOnce(
  `    host.close();
    await room.webSocketClose(host);
    expect(hanging.fetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    const alarm = room.alarm();
`,
  `    host.close();
    await room.webSocketClose(host);
    expect(hanging.fetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(120_000);
    const alarm = room.alarm();
`,
  'bounded maintenance read reclaim deadline',
);

replaceWorkerTestOnce(
  `    expect(await state.storage.get('roomMeta')).toMatchObject({
      hostPeerId: null,
      hostReleaseAt: Date.now() + 120_000,
    });
    expect(state.storage.alarmTime).toBe(Date.now() + 60_000);
`,
  `    expect(await state.storage.get('roomMeta')).toMatchObject({
      hostPeerId: null,
      hostReleaseAt: Date.now() + 120_000,
    });
    expect(state.storage.alarmTime).toBe(Date.now() + 120_000);
`,
  'interrupted close persistence alarm deadline',
);

replaceWorkerTestOnce(
  `    await room.webSocketClose(firstHost);
    vi.advanceTimersByTime(61_001);
    await room.alarm();
`,
  `    await room.webSocketClose(firstHost);
    vi.advanceTimersByTime(121_001);
    await room.alarm();
`,
  'room generation rotation after reclaim grace',
);

replaceWorkerTestOnce(
  `    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'secret-a',
      hostPeerId: null,
      hostReleaseAt: Date.now() + 120_000,
    });
    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: [{ peerId: 'guest-1' }],
    });
    expect(state.storage.alarmTime).toBe(Date.now() + 60_000);
`,
  `    expect(await state.storage.get('roomMeta')).toMatchObject({
      roomSecret: 'secret-a',
      hostPeerId: null,
      hostReleaseAt: Date.now() + 120_000,
    });
    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: [{ peerId: 'guest-1' }],
    });
    expect(state.storage.alarmTime).toBe(Date.now() + 120_000);
`,
  'last guest host-grace alarm deadline',
);

replaceWorkerTestOnce(
  `    vi.setSystemTime(new Date('2026-05-16T00:01:01.000Z'));
    const reclaimed = await authenticateHost(room, 'host-3', 'secret-b');
`,
  `    vi.setSystemTime(new Date('2026-05-16T00:02:01.000Z'));
    const reclaimed = await authenticateHost(room, 'host-3', 'secret-b');
`,
  'lazy different-secret reclaim time',
);

replaceWorkerTestOnce(
  `    await room.webSocketClose(host);
    vi.setSystemTime(new Date('2026-05-16T00:01:01.000Z'));
    await room.fetch(wsRequest('123456', 'host', 'host-frame-after-grace'));
`,
  `    await room.webSocketClose(host);
    vi.setSystemTime(new Date('2026-05-16T00:02:01.000Z'));
    await room.fetch(wsRequest('123456', 'host', 'host-frame-after-grace'));
`,
  'first-frame reclaim time',
);

replaceWorkerTestOnce(
  `    await room.webSocketClose(host);
    expect(state.storage.alarmTime).toBe(Date.now() + 60_000);

    vi.advanceTimersByTime(60_000);
    await room.alarm();

    expect(await state.storage.get('roomMeta')).toEqual({
`,
  `    await room.webSocketClose(host);
    expect(state.storage.alarmTime).toBe(Date.now() + 120_000);

    vi.advanceTimersByTime(120_000);
    await room.alarm();

    expect(await state.storage.get('roomMeta')).toEqual({
`,
  'host-only secret cleanup deadline',
);

replaceWorkerTestOnce(
  `    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: [{ peerId: 'guest-1' }],
    });
    vi.advanceTimersByTime(60_000);
    await room.alarm();

    expect(guest.closed).toBe(true);
`,
  `    expect(await state.storage.get('guestReconnectBindings')).toMatchObject({
      entries: [{ peerId: 'guest-1' }],
    });
    vi.advanceTimersByTime(120_000);
    await room.alarm();

    expect(guest.closed).toBe(true);
`,
  'prior-epoch guest expiry deadline',
);

replaceWorkerTestOnce(
  `    expect(guest.closed).toBe(true);
    expect(state.storage.alarmTime).toBe(startedAt + 60_000);

    vi.setSystemTime(startedAt + 60_000);
`,
  `    expect(guest.closed).toBe(true);
    expect(state.storage.alarmTime).toBe(startedAt + 120_000);

    vi.setSystemTime(startedAt + 120_000);
`,
  'shared pending-auth and host-cleanup alarm deadline',
);

write(workerTestPath, workerTests);

// The base generator performs the cache-epoch cutover. Verify it rather than
// silently accepting a partial app-shell update.
if (!read('scripts/service-worker-asset.ts').includes("SERVICE_WORKER_CACHE_VERSION = 'v460'")) {
  throw new Error('service-worker cache epoch did not advance to v460');
}
if (!read('index.html').includes('/bootstrap.js?cache=v460')) {
  throw new Error('classic bootstrap cache identity did not advance to v460');
}

write(
  'docs/design/signaling-liveness.md',
  `# Standard-Host Signaling Liveness and Reclaim Safety

- **Status:** Accepted
- **Decision date:** 2026-08-20
- **Scope:** Standard-room host signaling only

## Problem

Windows Chromium can retain a dead signaling WebSocket in the \`OPEN\` state after the
network route disappears. The signaling Durable Object may already have observed the host
close and started its reclaim deadline while the browser has not emitted \`close\` or
\`error\`. During that gap, automatic recovery does not start and a room code can lose
its authenticated host epoch before the host knows it must reconnect.

## Decision

An authenticated Standard-room host monitors only its exact signaling WebSocket. After ten
seconds without any server traffic it sends one fixed application-level probe. Any ordinary
server frame or the fixed pong proves liveness. If eight more seconds pass without a response,
the exact socket generation is retired and the existing 1/2/4/8/15-second recovery loop starts
automatically. Existing WebRTC data channels, playback, and system-audio media stay intact.

The Worker advertises protocol version 1 only from deployed Workers carrying version metadata.
Durable Objects use \`setWebSocketAutoResponse()\` when available, with an explicit local/test
fallback. Guests and PRO rooms do not run the periodic probe. Browser \`offline\` and \`online\`
events are fast hints for the same Standard-host recovery path.

The Standard-host reclaim grace is extended from 60 to 120 seconds. New guests remain rejected
while no live host socket exists; the longer grace only preserves the authenticated host's
right to reclaim the same room epoch.

## Unchanged policies

- UI layout, copy, and interaction flow are unchanged.
- Media loading remains best-effort until the browser/device itself fails.
- The 200 MiB limit remains a remote transfer/private-storage protocol ceiling, not a RAM
  admission limit.
- Existing CI and production release workflows remain unchanged.
`,
);

console.log('Applied host-only signaling watchdog, 120-second reclaim grace, and v460 release identity.');
