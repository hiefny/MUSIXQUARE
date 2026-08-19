import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

writeFileSync(
  'src/network/transport/signaling-liveness.ts',
  `import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';

export const SIGNALING_LIVENESS_VERSION = 1 as const;
export const SIGNALING_LIVENESS_PING =
  '{"type":"signaling-liveness-ping","version":1}';
export const SIGNALING_LIVENESS_PONG =
  '{"type":"signaling-liveness-pong","version":1}';
export const SIGNALING_LIVENESS_INTERVAL_MS = 10_000;
export const SIGNALING_LIVENESS_TIMEOUT_MS = 8_000;
const SIGNALING_LIVENESS_SUSPENSION_GAP_MS = 30_000;

interface SignalingProbe {
  readonly idleTimerKey: string;
  readonly timeoutTimerKey: string;
  lastServerActivityAt: number;
  awaitingSince: number | null;
}

let nextMonitorId = 0;

/**
 * Host-only application liveness for one exact signaling WebSocket generation.
 *
 * The transport starts this monitor only for an authenticated Standard-room
 * host after the deployed Worker advertises protocol version 1. Normal server
 * traffic postpones the probe. A missing pong retires only the signaling socket;
 * existing WebRTC data channels and media continue while peer.ts reconnects.
 */
export class SignalingSocketLivenessMonitor {
  private readonly monitorId = ++nextMonitorId;
  private nextSocketId = 0;
  private readonly probes = new Map<WebSocket, SignalingProbe>();

  constructor(private readonly onUnresponsive: (socket: WebSocket) => void) {}

  start(socket: WebSocket): void {
    this.stop(socket);
    const socketId = ++this.nextSocketId;
    const probe: SignalingProbe = {
      idleTimerKey: \`signaling-liveness-idle-\${this.monitorId}-\${socketId}\`,
      timeoutTimerKey: \`signaling-liveness-timeout-\${this.monitorId}-\${socketId}\`,
      lastServerActivityAt: Date.now(),
      awaitingSince: null,
    };
    this.probes.set(socket, probe);
    this.armIdleProbe(socket, probe, SIGNALING_LIVENESS_INTERVAL_MS);
  }

  /** Returns true only for the transport-owned pong frame. */
  noteMessage(socket: WebSocket, raw: unknown): boolean {
    const isPong = raw === SIGNALING_LIVENESS_PONG;
    const probe = this.probes.get(socket);
    if (!probe) return isPong;

    probe.lastServerActivityAt = Date.now();
    probe.awaitingSince = null;
    clearManagedTimer(probe.timeoutTimerKey);
    this.armIdleProbe(socket, probe, SIGNALING_LIVENESS_INTERVAL_MS);
    return isPong;
  }

  stop(socket: WebSocket): void {
    const probe = this.probes.get(socket);
    if (!probe) return;
    clearManagedTimer(probe.idleTimerKey);
    clearManagedTimer(probe.timeoutTimerKey);
    this.probes.delete(socket);
  }

  stopAll(): void {
    for (const socket of Array.from(this.probes.keys())) this.stop(socket);
  }

  private isHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  private armIdleProbe(socket: WebSocket, probe: SignalingProbe, delayMs: number): void {
    if (this.probes.get(socket) !== probe) return;
    setManagedTimer(probe.idleTimerKey, () => this.sendProbe(socket, probe), delayMs);
  }

  private fail(socket: WebSocket, probe: SignalingProbe): void {
    if (this.probes.get(socket) !== probe) return;
    this.stop(socket);
    this.onUnresponsive(socket);
  }

  private sendProbe(socket: WebSocket, probe: SignalingProbe): void {
    if (this.probes.get(socket) !== probe) return;
    const now = Date.now();

    if (this.isHidden()) {
      probe.lastServerActivityAt = now;
      probe.awaitingSince = null;
      this.armIdleProbe(socket, probe, SIGNALING_LIVENESS_INTERVAL_MS);
      return;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      this.fail(socket, probe);
      return;
    }

    const idleFor = now - probe.lastServerActivityAt;
    if (idleFor < SIGNALING_LIVENESS_INTERVAL_MS) {
      this.armIdleProbe(socket, probe, SIGNALING_LIVENESS_INTERVAL_MS - idleFor);
      return;
    }

    try {
      socket.send(SIGNALING_LIVENESS_PING);
      probe.awaitingSince = now;
      setManagedTimer(
        probe.timeoutTimerKey,
        () => this.handleProbeTimeout(socket, probe),
        SIGNALING_LIVENESS_TIMEOUT_MS,
      );
    } catch {
      this.fail(socket, probe);
    }
  }

  private handleProbeTimeout(socket: WebSocket, probe: SignalingProbe): void {
    if (this.probes.get(socket) !== probe || probe.awaitingSince === null) return;
    const now = Date.now();
    const elapsed = now - probe.awaitingSince;

    // A background-throttled callback can arrive long after its deadline. That
    // delay is not evidence that the server was unreachable at the deadline.
    if (
      this.isHidden() ||
      elapsed > SIGNALING_LIVENESS_TIMEOUT_MS + SIGNALING_LIVENESS_SUSPENSION_GAP_MS
    ) {
      probe.awaitingSince = null;
      probe.lastServerActivityAt = now;
      this.armIdleProbe(socket, probe, SIGNALING_LIVENESS_INTERVAL_MS);
      return;
    }

    this.fail(socket, probe);
  }
}
`,
  'utf8',
);

const baselineRoot = join(tmpdir(), `musixquare-main-dead-exports-${process.pid}`);
rmSync(baselineRoot, { recursive: true, force: true });
execFileSync('git', ['worktree', 'add', '--detach', baselineRoot, 'origin/main'], {
  stdio: 'inherit',
});

let newSelfOnly = [];
try {
  const candidate = JSON.parse(
    execFileSync(process.execPath, ['scripts/check-dead-exports.mts', '--analyze-json'], {
      encoding: 'utf8',
    }),
  );
  const baseline = JSON.parse(
    execFileSync(
      process.execPath,
      ['scripts/check-dead-exports.mts', '--analyze-json', baselineRoot],
      { encoding: 'utf8' },
    ),
  );
  const baselineKeys = new Set(baseline.selfOnly.map((entry) => entry.key));
  newSelfOnly = candidate.selfOnly.filter((entry) => !baselineKeys.has(entry.key));
} finally {
  execFileSync('git', ['worktree', 'remove', '--force', baselineRoot], { stdio: 'inherit' });
  rmSync(baselineRoot, { recursive: true, force: true });
}

console.log('=== NEW SELF-ONLY BINDINGS VS MAIN ===');
for (const entry of newSelfOnly) {
  const sites = entry.sites.map((site) => `${site.name} @ ${site.file}`).join(', ');
  console.log(
    `[${entry.kind}] ${sites} ` +
      `(refs prod=${entry.refs.prod}, test=${entry.refs.test}, self=${entry.refs.self})`,
  );
}
console.log('=== END NEW SELF-ONLY BINDINGS ===');
if (newSelfOnly.length > 0) {
  throw new Error(`Diagnostic stop: ${newSelfOnly.length} new self-only bindings`);
}

console.log('Finalized 10-second idle / 8-second timeout host signaling monitor.');
