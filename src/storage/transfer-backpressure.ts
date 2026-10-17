/** Event-driven capacity waits shared by direct file and preload senders. */
import { CHUNK_SIZE, DELAY } from '../core/constants.ts';
import type { DataConnection } from '../types/index.ts';

type CapacityResult = 'ready' | 'stopped' | 'timeout';

interface ChannelThresholdOwner {
  waiters: Map<object, number>;
  previous: number;
  installed: number;
}

const thresholdOwners = new WeakMap<RTCDataChannel, ChannelThresholdOwner>();

/** Recheck synchronously immediately before send: another lane may have used
 * the connection's credit while a read or capacity wait yielded. */
export function hasTransferCapacity(
  conn: DataConnection,
  highWaterMark: number,
  nextPayloadBytes = CHUNK_SIZE,
): boolean {
  return (
    conn.open &&
    (!conn.dataChannel?.readyState || conn.dataChannel.readyState === 'open') &&
    (!conn.dataChannel || conn.dataChannel.bufferedAmount <= highWaterMark) &&
    (conn.bulkFlowControl?.hasCapacity(nextPayloadBytes) ?? true)
  );
}

function installThreshold(channel: RTCDataChannel, owner: ChannelThresholdOwner): void {
  // Preserve a newer external assignment when this helper next takes ownership.
  if (channel.bufferedAmountLowThreshold !== owner.installed) {
    owner.previous = channel.bufferedAmountLowThreshold;
  }
  owner.installed = Math.max(...owner.waiters.values());
  channel.bufferedAmountLowThreshold = owner.installed;
}

function claimThreshold(channel: RTCDataChannel, limit: number): () => void {
  let owner = thresholdOwners.get(channel);
  if (!owner) {
    owner = {
      waiters: new Map(),
      previous: channel.bufferedAmountLowThreshold,
      installed: channel.bufferedAmountLowThreshold,
    };
    thresholdOwners.set(channel, owner);
  }
  const token = {};
  owner.waiters.set(token, limit);
  try {
    // Wake the highest-window waiter first, then lower the threshold for the
    // remaining waiters. One preload must not replace an active file's event.
    installThreshold(channel, owner);
  } catch {
    // A partial implementation can reject the threshold setter. Polling still
    // handles progress, cancellation and timeout below.
  }
  return () => {
    owner.waiters.delete(token);
    try {
      if (owner.waiters.size > 0) installThreshold(channel, owner);
      else if (channel.bufferedAmountLowThreshold === owner.installed) {
        channel.bufferedAmountLowThreshold = owner.previous;
      }
    } catch {
      // Closing channels may reject property writes during cleanup.
    } finally {
      if (owner.waiters.size === 0) thresholdOwners.delete(channel);
    }
  };
}

/**
 * Wait for this exact channel's capacity without imposing a polling delay on
 * healthy RTC implementations. The bounded fallback also observes cancellation
 * and handles lost/unsupported low-watermark events. Predicates must not throw.
 */
export function waitForTransferCapacity(
  conn: DataConnection,
  highWaterMark: number,
  timeoutMs: number,
  shouldContinue: () => boolean,
  nextPayloadBytes = CHUNK_SIZE,
): Promise<CapacityResult> {
  const channel = conn.dataChannel;
  const flow = conn.bulkFlowControl;
  const isCurrent = (): boolean =>
    shouldContinue() &&
    conn.open &&
    conn.dataChannel === channel &&
    conn.bulkFlowControl === flow &&
    (!channel?.readyState || channel.readyState === 'open');
  if (!isCurrent()) return Promise.resolve('stopped');
  if (hasTransferCapacity(conn, highWaterMark, nextPayloadBytes)) return Promise.resolve('ready');

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let releaseThreshold: (() => void) | null = null;
    let releaseCredit: (() => void) | null = null;
    const finish = (result: CapacityResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      channel?.removeEventListener?.('bufferedamountlow', check);
      channel?.removeEventListener?.('close', stop);
      channel?.removeEventListener?.('error', stop);
      releaseThreshold?.();
      releaseCredit?.();
      resolve(result);
    };
    const stop = (): void => finish('stopped');
    const check = (): void => {
      if (!isCurrent()) finish('stopped');
      else if (hasTransferCapacity(conn, highWaterMark, nextPayloadBytes)) finish('ready');
      else if (Date.now() - startedAt >= timeoutMs) finish('timeout');
    };
    const poll = (): void => {
      check();
      if (!settled) {
        const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
        // eslint-disable-next-line no-restricted-globals -- this wait must survive session timer cleanup to settle and release its channel listeners
        timer = setTimeout(poll, Math.min(DELAY.BACKPRESSURE, remaining));
      }
    };

    if (
      channel &&
      typeof channel.addEventListener === 'function' &&
      typeof channel.removeEventListener === 'function'
    ) {
      releaseThreshold = claimThreshold(channel, highWaterMark);
      try {
        channel.addEventListener('bufferedamountlow', check);
        channel.addEventListener('close', stop);
        channel.addEventListener('error', stop);
      } catch {
        // Partially supported facades must not strand a threshold or listener
        // if registration fails; use the same bounded polling fallback.
        channel.removeEventListener('bufferedamountlow', check);
        channel.removeEventListener('close', stop);
        channel.removeEventListener('error', stop);
        releaseThreshold();
        releaseThreshold = null;
      }
    }
    releaseCredit = flow?.subscribe(check) ?? null;
    // A provider may synchronously signal while subscribing.
    if (settled) releaseCredit?.();
    // Drain/closure can happen between the initial check and registration.
    poll();
  });
}
