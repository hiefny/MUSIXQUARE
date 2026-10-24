// The active PRO upload queue as the playlist view reads it. It is kept apart
// from the queue itself (upload-queue.ts) because ui/playlist-view.ts renders
// and cancels upload rows from the startup graph, while ProRoomUploadQueue is
// constructed and activated only by the lazy PRO runtime.
import type { ProRoomUploadQueue, ProRoomUploadRow, UploadQueueListener } from './upload-queue.ts';

let activeQueue: ProRoomUploadQueue | null = null;
let unsubscribeActiveQueue: (() => void) | null = null;
const activeQueueListeners = new Set<UploadQueueListener>();

function notifyActiveQueueListeners(): void {
  for (const listener of [...activeQueueListeners]) {
    try {
      listener();
    } catch {
      // One detached view must not block the remaining projection observers.
    }
  }
}

export function setActiveProRoomUploadQueue(queue: ProRoomUploadQueue | null): void {
  if (activeQueue === queue) return;
  unsubscribeActiveQueue?.();
  unsubscribeActiveQueue = null;
  activeQueue = queue;
  if (queue) unsubscribeActiveQueue = queue.subscribe(notifyActiveQueueListeners);
  notifyActiveQueueListeners();
}

export function getProRoomUploadRows(): readonly ProRoomUploadRow[] {
  return activeQueue?.rows ?? [];
}

export function subscribeProRoomUploadRows(listener: UploadQueueListener): () => void {
  activeQueueListeners.add(listener);
  return () => activeQueueListeners.delete(listener);
}

export function cancelProRoomUpload(id: string): boolean {
  return activeQueue?.cancel(id) ?? false;
}

export function acknowledgeCommittedProRoomUploads(ids: ReadonlySet<string>): boolean {
  return activeQueue?.acknowledgeCommitted(ids) ?? false;
}
