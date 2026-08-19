#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    source = read(path)
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one marker, found {count}: {old[:120]!r}")
    write(path, source.replace(old, new, 1))


# Transport interface: expose a narrow provider hook for retiring a half-open
# signaling socket without touching established WebRTC data/media channels.
replace_once(
    "src/network/transport/types.ts",
    "  reconnect?(): void;\n",
    """  reconnect?(): void;
  /**
   * Retire the provider's current signaling socket generation and publish the
   * ordinary disconnected lifecycle while preserving established direct
   * WebRTC channels. Providers without a retained signaling socket omit it.
   */
  forceSignalingReconnect?(): void;
""",
)

# Cloudflare transport: identity-fence the exact socket generation before close
# so the synchronous close callback cannot double-publish or evict a successor.
cloudflare_reconnect_block = """  reconnect(): void {
    if (this.destroyed) return;
    if (this.hostRoomId) {
      this.openHostSocket();
      return;
    }
    for (const [roomId, record] of this.guestRooms) {
      // Dead sessions belong to the join/HOST_DISCONNECTED re-join path, and
      // mid-handshake conns (peerConnection set, open=false) stay with the
      // join timeout — reconnect only serves established sessions whose
      // signaling socket blipped.
      if (!this.isDataConnectionAlive(record.conn)) continue;
      this.ensureGuestSocket(roomId);
    }
  }

  recoverAfterBackground(hiddenMs: number): TransportBackgroundRecoveryResult {
"""
cloudflare_reconnect_replacement = """  reconnect(): void {
    if (this.destroyed) return;
    if (this.hostRoomId) {
      this.openHostSocket();
      return;
    }
    for (const [roomId, record] of this.guestRooms) {
      // Dead sessions belong to the join/HOST_DISCONNECTED re-join path, and
      // mid-handshake conns (peerConnection set, open=false) stay with the
      // join timeout — reconnect only serves established sessions whose
      // signaling socket blipped.
      if (!this.isDataConnectionAlive(record.conn)) continue;
      this.ensureGuestSocket(roomId);
    }
  }

  forceSignalingReconnect(): void {
    if (this.destroyed) return;
    if (this.disconnected) {
      this.reconnect();
      return;
    }

    let retired = false;
    if (this.hostRoomId) {
      const socket = this.hostSocket;
      // Revoke singleton ownership before close(): browser implementations
      // may dispatch the close event synchronously from this call.
      this.hostSocket = null;
      this.remoteShareUploadAssertionStatus = this.remoteShareUploadAssertionObserved
        ? 'unavailable'
        : 'unknown';
      this.open = false;
      retired = socket !== null;
      if (socket) {
        this.rejectPendingRemoteShareUploadAssertions(
          socket,
          'REMOTE_SHARE_UPLOAD_ASSERTION_SOCKET_RETIRED',
        );
        try {
          socket.close();
        } catch {
          /* noop */
        }
      }
    } else {
      for (const [roomId, socket] of [...this.roomSockets]) {
        const record = this.guestRooms.get(roomId);
        if (!record || !this.isDataConnectionAlive(record.conn)) continue;
        if (this.roomSockets.get(roomId) !== socket) continue;
        this.roomSockets.delete(roomId);
        retired = true;
        try {
          socket.close();
        } catch {
          /* noop */
        }
      }
    }

    // A retained host identity with a missing socket is also a broken
    // signaling generation. Publish the same lifecycle so the outer backoff
    // can construct a fresh socket instead of trusting `open`.
    if (!retired && !this.hostRoomId) return;

    this.disconnected = true;
    this.emit('disconnected');
  }

  recoverAfterBackground(hiddenMs: number): TransportBackgroundRecoveryResult {
"""
replace_once(
    "src/network/transport/cloudflare-signaling.ts",
    cloudflare_reconnect_block,
    cloudflare_reconnect_replacement,
)

signaling_reachability = r"""import { log } from '../../core/log.ts';
import { clearManagedTimer, setManagedTimer } from '../../core/timers.ts';
import type { TransportPeer, TransportPeerOptions } from './types.ts';

const SIGNALING_REACHABILITY_PROBE_INTERVAL_MS = 10_000;
const SIGNALING_REACHABILITY_PROBE_TIMEOUT_MS = 4_000;
let signalingReachabilityMonitorSequence = 0;

function browserReachabilityAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof fetch === 'function' &&
    typeof AbortController !== 'undefined'
  );
}

function buildProbeUrl(signalingUrl: string): string {
  const url = new URL(signalingUrl, window.location.href);
  url.searchParams.set('__mxqr_reachability', Date.now().toString(36));
  return url.toString();
}

/**
 * Foreground host/coordinator reachability monitor.
 *
 * WebSocket close/error delivery is intentionally not treated as the only
 * liveness signal: Windows can retain a half-open WebSocket after every
 * network interface is disabled. A bounded, uncached request to the same
 * signaling endpoint detects that silent path failure. The transport then
 * retires only its signaling socket generation; established WebRTC data/media
 * channels remain owned by their existing room lifecycle.
 */
export function attachSignalingReachabilityMonitor(
  peer: TransportPeer,
  requestedId: string | null,
  options: TransportPeerOptions,
): TransportPeer {
  if (
    requestedId === null ||
    options.provider !== 'cloudflare' ||
    !options.signalingUrl ||
    !browserReachabilityAvailable() ||
    typeof peer.forceSignalingReconnect !== 'function'
  ) {
    return peer;
  }

  const sequence = ++signalingReachabilityMonitorSequence;
  const intervalTimerKey = `signaling-reachability-interval-${sequence}`;
  const timeoutTimerKey = `signaling-reachability-timeout-${sequence}`;
  const originalDestroy = peer.destroy.bind(peer);
  let disposed = false;
  let probeGeneration = 0;
  let activeController: AbortController | null = null;
  let probing = false;

  const cancelActiveProbe = (): void => {
    probeGeneration += 1;
    const controller = activeController;
    activeController = null;
    probing = false;
    clearManagedTimer(timeoutTimerKey);
    controller?.abort();
  };

  const stop = (): void => {
    clearManagedTimer(intervalTimerKey);
    cancelActiveProbe();
  };

  const retireSignaling = (reason: string, error?: unknown): void => {
    if (disposed || peer.destroyed || peer.disconnected) return;
    log.warn(`[Transport] Signaling reachability lost (${reason}); retiring socket generation`, error);
    stop();
    peer.forceSignalingReconnect?.();
  };

  const probe = async (): Promise<void> => {
    if (
      disposed ||
      probing ||
      peer.destroyed ||
      !peer.open ||
      peer.disconnected ||
      document.visibilityState === 'hidden'
    ) {
      return;
    }
    if (navigator.onLine === false) {
      retireSignaling('browser-offline');
      return;
    }

    probing = true;
    const generation = ++probeGeneration;
    const controller = new AbortController();
    activeController = controller;
    setManagedTimer(
      timeoutTimerKey,
      () => controller.abort(new Error('SIGNALING_REACHABILITY_TIMEOUT')),
      SIGNALING_REACHABILITY_PROBE_TIMEOUT_MS,
    );

    try {
      await fetch(buildProbeUrl(options.signalingUrl!), {
        method: 'HEAD',
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (error) {
      if (disposed || generation !== probeGeneration) return;
      retireSignaling(
        controller.signal.aborted ? 'probe-timeout' : 'probe-failed',
        error,
      );
    } finally {
      if (generation === probeGeneration) {
        clearManagedTimer(timeoutTimerKey);
        activeController = null;
        probing = false;
      }
    }
  };

  const start = (): void => {
    if (disposed || peer.destroyed || !peer.open || peer.disconnected) return;
    clearManagedTimer(intervalTimerKey);
    setManagedTimer(
      intervalTimerKey,
      () => {
        void probe();
      },
      SIGNALING_REACHABILITY_PROBE_INTERVAL_MS,
      { interval: true },
    );
    void probe();
  };

  const onOpen = (): void => start();
  const onDisconnected = (): void => stop();
  const onOffline = (): void => retireSignaling('browser-offline');
  const onOnline = (): void => {
    if (disposed || peer.destroyed) return;
    if (peer.disconnected) {
      peer.reconnect?.();
      return;
    }
    void probe();
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      cancelActiveProbe();
      return;
    }
    if (peer.open && !peer.disconnected) void probe();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stop();
    peer.off?.('open', onOpen);
    peer.off?.('disconnected', onDisconnected);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };

  peer.on('open', onOpen);
  peer.on('disconnected', onDisconnected);
  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibilityChange);
  peer.destroy = (): void => {
    dispose();
    originalDestroy();
  };

  if (peer.open && !peer.disconnected) start();
  return peer;
}

export const __signalingReachabilityForTests = {
  SIGNALING_REACHABILITY_PROBE_INTERVAL_MS,
  SIGNALING_REACHABILITY_PROBE_TIMEOUT_MS,
};
"""
write("src/network/transport/signaling-reachability.ts", signaling_reachability)

replace_once(
    "src/network/transport/index.ts",
    """import { createPeerJsPeer } from './peerjs-adapter.ts';
import type { TransportPeer, TransportPeerOptions } from './types.ts';
""",
    """import { createPeerJsPeer } from './peerjs-adapter.ts';
import { attachSignalingReachabilityMonitor } from './signaling-reachability.ts';
import type { TransportPeer, TransportPeerOptions } from './types.ts';
""",
)
replace_once(
    "src/network/transport/index.ts",
    """  if (options.provider === 'cloudflare') {
    return createCloudflarePeer(requestedId, options);
  }
  return createPeerJsPeer(requestedId, options);
""",
    """  const peer =
    options.provider === 'cloudflare'
      ? createCloudflarePeer(requestedId, options)
      : createPeerJsPeer(requestedId, options);
  return attachSignalingReachabilityMonitor(peer, requestedId, options);
""",
)

reachability_test = r"""/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import {
  attachSignalingReachabilityMonitor,
  __signalingReachabilityForTests,
} from '../signaling-reachability.ts';
import type { TransportPeer, TransportPeerOptions } from '../types.ts';

type PeerEvent = 'open' | 'disconnected';
type PeerListener = (...args: unknown[]) => void;

function createFakePeer(initial: Partial<Pick<TransportPeer, 'open' | 'disconnected'>> = {}) {
  const listeners = new Map<PeerEvent, Set<PeerListener>>();
  const originalDestroy = vi.fn();
  const reconnect = vi.fn();
  const forceSignalingReconnect = vi.fn();
  const peer = {
    open: initial.open ?? true,
    disconnected: initial.disconnected ?? false,
    destroyed: false,
    reconnect,
    forceSignalingReconnect,
    destroy: originalDestroy,
    on(event: PeerEvent, callback: PeerListener) {
      const bucket = listeners.get(event) ?? new Set<PeerListener>();
      bucket.add(callback);
      listeners.set(event, bucket);
    },
    off(event: PeerEvent, callback: PeerListener) {
      listeners.get(event)?.delete(callback);
    },
  } as unknown as TransportPeer;

  const emit = (event: PeerEvent): void => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  forceSignalingReconnect.mockImplementation(() => {
    if (peer.disconnected) return;
    peer.disconnected = true;
    emit('disconnected');
  });
  originalDestroy.mockImplementation(() => {
    peer.destroyed = true;
  });

  return { peer, emit, reconnect, forceSignalingReconnect, originalDestroy };
}

const options = {
  provider: 'cloudflare',
  signalingUrl: 'https://signal.example.test/api/rooms',
  config: { iceServers: [] },
} as TransportPeerOptions;

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
});

afterEach(() => {
  clearAllManagedTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('signaling reachability monitor', () => {
  it('retires a host signaling generation when the endpoint probe rejects silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network offline')));
    const { peer, forceSignalingReconnect } = createFakePeer();

    attachSignalingReachabilityMonitor(peer, '123456', options);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledOnce();
    expect(forceSignalingReconnect).toHaveBeenCalledOnce();
  });

  it('reacts immediately to browser offline and removes global listeners on destroy', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const { peer, forceSignalingReconnect, originalDestroy } = createFakePeer();

    attachSignalingReachabilityMonitor(peer, '123456', options);
    window.dispatchEvent(new Event('offline'));
    expect(forceSignalingReconnect).toHaveBeenCalledOnce();

    peer.destroy();
    expect(originalDestroy).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('offline'));
    expect(forceSignalingReconnect).toHaveBeenCalledOnce();
  });

  it('keeps healthy hosts unchanged and probes again on the foreground interval', async () => {
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal('fetch', fetchMock);
    const { peer, forceSignalingReconnect } = createFakePeer();

    attachSignalingReachabilityMonitor(peer, '123456', options);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(
      __signalingReachabilityForTests.SIGNALING_REACHABILITY_PROBE_INTERVAL_MS,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(forceSignalingReconnect).not.toHaveBeenCalled();
  });

  it('requests an immediate reopen when connectivity returns during recovery', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    const { peer, reconnect } = createFakePeer({ open: false, disconnected: true });

    attachSignalingReachabilityMonitor(peer, '123456', options);
    window.dispatchEvent(new Event('online'));

    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('does not install host probes for guests or the PeerJS development provider', () => {
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal('fetch', fetchMock);
    const guest = createFakePeer();
    const peerJs = createFakePeer();

    attachSignalingReachabilityMonitor(guest.peer, null, options);
    attachSignalingReachabilityMonitor(peerJs.peer, '123456', {
      ...options,
      provider: 'peerjs',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
"""
write("src/network/transport/__tests__/signaling-reachability.test.ts", reachability_test)

force_reconnect_test = r"""/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { CloudflareSignalingPeer } from '../cloudflare-signaling.ts';
import type { TransportPeerOptions } from '../types.ts';

type SocketListener = (event: { data?: unknown; reason?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  closeCount = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<SocketListener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: SocketListener): void {
    const bucket = this.listeners.get(event) ?? new Set<SocketListener>();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCount += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close');
  }

  dispatch(event: string, data?: unknown, reason?: string): void {
    if (event === 'open') this.readyState = FakeWebSocket.OPEN;
    if (event === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data, reason });
    }
  }
}

const originalWebSocket = globalThis.WebSocket;
const options = {
  provider: 'cloudflare',
  signalingUrl: 'https://signal.example.test/api/rooms',
  config: { iceServers: [] },
} as TransportPeerOptions;

beforeEach(() => {
  clearAllManagedTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  clearAllManagedTimers();
  vi.unstubAllGlobals();
  globalThis.WebSocket = originalWebSocket;
});

describe('Cloudflare signaling generation retirement', () => {
  it('detaches the exact half-open host socket before close and publishes once', async () => {
    const peer = new CloudflareSignalingPeer('123456', options);
    const disconnected = vi.fn();
    peer.on('disconnected', disconnected);

    await Promise.resolve();
    const socket = FakeWebSocket.instances[0]!;
    socket.dispatch('open');
    socket.dispatch(
      'message',
      JSON.stringify({ type: 'peer-open', peerId: '123456', roomId: '123456' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(peer.open).toBe(true);

    peer.forceSignalingReconnect();

    expect(socket.closeCount).toBe(1);
    expect(peer.open).toBe(false);
    expect(peer.disconnected).toBe(true);
    expect(disconnected).toHaveBeenCalledOnce();

    peer.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(2);
    peer.destroy();
  });
});
"""
write(
    "src/network/transport/__tests__/cloudflare-signaling-force-reconnect.test.ts",
    force_reconnect_test,
)

design_doc = r"""# Signaling Reachability and Invite Recovery

- **Status:** Accepted
- **Decision date:** 2026-08-19
- **Applies to:** standard-room hosts and PRO coordinators using Cloudflare signaling

## Problem

Some Windows networking stacks can retain an apparently open browser WebSocket
after Wi-Fi, Ethernet, or the upstream route disappears. Existing WebRTC data
channels may remain usable, but the signaling server cannot admit a new device.
Waiting only for WebSocket `close` or `error` therefore leaves the QR invite
control showing **Copy invite link** even though the room is no longer joinable.

Mobile browsers usually report the socket loss quickly, which made the same
outage appear platform-dependent.

## Decision

The Cloudflare host/coordinator transport has two independent liveness inputs:

1. WebSocket `close` and `error`, retained as the primary transport lifecycle.
2. A foreground-only, uncached `HEAD` probe to the configured signaling
   endpoint every 10 seconds, bounded by a 4-second timeout.

The browser `offline` event is an immediate hint and the `online` event requests
an immediate reopen. The endpoint probe remains authoritative when
`navigator.onLine` stays true because a virtual adapter or local network is
still present.

A failed probe retires the **exact current signaling socket generation** before
closing it, then emits the existing `disconnected` lifecycle. The ordinary
1/2/4/8/15-second recovery budget updates `network.signalingHealth`, so the QR
button changes to **Recovering** without adding a second UI state machine.

## Preserved behavior

- Established WebRTC data channels and system-audio media remain in place.
- Standard and PRO room authority rules do not change.
- Guests do not create endpoint-probe traffic; only the invite-owning host or
  coordinator is monitored.
- Probes pause while the document is hidden and are removed when the transport
  is destroyed.
- UI layout, copy, and interaction remain unchanged.
- Media loading remains best-effort and RAM-only. The 200 MiB value remains a
  transfer/storage protocol ceiling, not a device-memory admission limit.

## Verification

Focused tests cover silent endpoint failure, immediate browser offline,
foreground interval probing, online recovery, provider/role scoping, cleanup,
and identity-fenced host socket retirement. The full TypeScript, unit,
browser-critical, production-build, and release-candidate checks remain the
merge and deployment gates.
"""
write("docs/design/signaling-reachability.md", design_doc)

replace_once(
    "scripts/service-worker-asset.ts",
    "export const SERVICE_WORKER_CACHE_VERSION = 'v459';",
    "export const SERVICE_WORKER_CACHE_VERSION = 'v460';",
)

for manifest_path in ("package.json", "package-lock.json"):
    manifest = json.loads(read(manifest_path))
    if manifest.get("version") != "8.3.72":
        raise RuntimeError(f"{manifest_path}: unexpected version {manifest.get('version')!r}")
    manifest["version"] = "8.3.73"
    if manifest_path == "package-lock.json":
        packages = manifest.get("packages")
        if not isinstance(packages, dict) or "" not in packages:
            raise RuntimeError("package-lock.json: root package missing")
        if packages[""].get("version") != "8.3.72":
            raise RuntimeError("package-lock.json: unexpected root package version")
        packages[""]["version"] = "8.3.73"
    write(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

# The runner executes this workflow from its original commit, so the final
# product commit can remove every agent-only automation artifact.
for transient in (
    ".github/workflows/agent-signaling-liveness.yml",
    "scripts/agent-signaling-liveness-patch.py",
):
    target = ROOT / transient
    if target.exists():
        target.unlink()
