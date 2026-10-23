/**
 * Same-origin multi-document doubles for BroadcastChannel, the `storage`
 * event and window.postMessage (structural plan C8, Phase 0c; registry RO-28).
 *
 * A `FakeOrigin` is one origin's set of documents. Each attached document gets
 * its own `BroadcastChannel` constructor and `localStorage` view, both bound to
 * that document, so code running in a JSDOM window or in the Vitest jsdom
 * global sends and receives as a separate tab would. Every cross-document
 * delivery is a queued task that runs only when the test drains the queue,
 * one task at a time, with microtasks and pending I/O settled in between.
 *
 * Calibrated against the HTML Standard, not device traces (no account pulse
 * trace exists in /debug or the flight recorder):
 * - BroadcastChannel postMessage (HTML "Broadcasting to other browsing
 *   contexts"): throws InvalidStateError when the sender is closed; a sender
 *   whose document is gone posts nothing; destinations are the other open
 *   same-name objects of the origin, the sender itself excluded but other
 *   objects in the sender's own document included; destinations are sorted in
 *   creation order; one task is queued per destination, and the task does
 *   nothing if the destination was closed before it ran. A message posted just
 *   before the sender's close() is still delivered. Each destination
 *   deserializes its own copy.
 * - Web storage ("The storage event"): setItem with an unchanged value,
 *   removeItem of an absent key and clear() of an empty area fire nothing;
 *   otherwise a `storage` event is queued for every other document sharing the
 *   area, never for the writer. A document whose storage access is blocked
 *   gets no event.
 * - window.postMessage: targetOrigin '/' means the sender's origin, '*' any;
 *   a mismatch drops the message silently. The event origin is the sender's.
 *
 * Ordering model: one FIFO queue across documents, which is one valid
 * interleaving. A test may pick another with `deliverNext(filter)`, but the
 * fake refuses to reorder two tasks with the same sender document, target
 * document and transport, because engines keep that order. A broadcast and a
 * storage event from one sender may reach a target in either order: they
 * travel through different engine paths before they are queued on the
 * target's task source. `hold()` keeps a document's tasks queued while it is
 * backgrounded, and `release()` lets them run.
 *
 * Left out: messageerror; workers and partitioned storage keys; bfcache
 * eligibility (a document is either attached or unloaded; C6-2 owns bfcache
 * orders); sessionStorage; engine throttling of background timers (tests
 * drive timers with Vitest's clock).
 */

/** Captured before any test installs fake timers. */
const realSetImmediate: (callback: () => void) => unknown =
  globalThis.setImmediate.bind(globalThis);

export type PulseTransport = 'broadcast' | 'storage' | 'window-message';

export type FakeStorageMode = 'available' | 'blocked' | 'quota-exceeded';

/** The parts of a window realm the fake uses. JSDOM windows and the Vitest global both fit. */
export interface FakeRealmWindow {
  readonly location: { readonly href: string; readonly origin: string };
  readonly EventTarget: typeof EventTarget;
  readonly MessageEvent: typeof MessageEvent;
  readonly StorageEvent: typeof StorageEvent;
  readonly DOMException: typeof DOMException;
  dispatchEvent(event: Event): boolean;
}

export interface FakeDocumentOptions {
  /** Install a BroadcastChannel constructor (default true); false leaves it undefined. */
  readonly broadcastChannel?: boolean;
  /** localStorage behaviour (default 'available'). */
  readonly storage?: FakeStorageMode;
}

type DeliverEntry = {
  readonly op: 'deliver' | 'drop';
  readonly task: number;
  readonly transport: PulseTransport;
  readonly from: string;
  readonly to: string;
  /** Channel id for broadcasts, 'window' otherwise. */
  readonly target: string;
  readonly reason?: 'closed' | 'unloaded';
};

export type PulseLogEntry =
  | {
      readonly op: 'open' | 'close';
      readonly doc: string;
      readonly channel: string;
      readonly name: string;
    }
  | {
      readonly op: 'post';
      readonly doc: string;
      readonly channel: string;
      readonly name: string;
      /** Destination channel ids at post time, in delivery order. */
      readonly to: readonly string[];
    }
  | {
      readonly op: 'storage-write';
      readonly doc: string;
      readonly key: string | null;
      readonly changed: boolean;
      /** Documents a `storage` event was queued for. */
      readonly to: readonly string[];
    }
  | {
      readonly op: 'window-post';
      readonly from: string;
      readonly to: string;
      readonly targetOrigin: string;
      readonly accepted: boolean;
    }
  | DeliverEntry
  | { readonly op: 'unload'; readonly doc: string };

/** A queued delivery as tests see it. */
export interface PulseTask {
  readonly id: number;
  readonly transport: PulseTransport;
  readonly from: string;
  readonly to: string;
  /** Channel id for broadcasts, 'window' otherwise. */
  readonly target: string;
  /** Channel name, storage key, or null for window messages and clear(). */
  readonly key: string | null;
  /** The cloned message, or the storage event's newValue. */
  readonly data: unknown;
}

export type PulseTaskFilter =
  | Partial<Pick<PulseTask, 'transport' | 'from' | 'to' | 'target' | 'key'>>
  | ((task: PulseTask) => boolean);

interface QueuedTask {
  readonly task: PulseTask;
  readonly run: () => void;
}

interface ChannelRecord {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly doc: FakeDocument;
  readonly channel: EventTarget;
  closed: boolean;
}

export interface FakeWindowProxy {
  postMessage(message: unknown, targetOrigin?: string): void;
}

function matches(task: PulseTask, filter: PulseTaskFilter | undefined): boolean {
  if (!filter) return true;
  if (typeof filter === 'function') return filter(task);
  return (Object.keys(filter) as Array<keyof typeof filter>).every(
    (key) => filter[key] === task[key],
  );
}

function sameLane(a: PulseTask, b: PulseTask): boolean {
  return a.from === b.from && a.to === b.to && a.transport === b.transport;
}

/** One origin: its documents, its shared localStorage area and its delivery queue. */
export class FakeOrigin {
  readonly origin: string;
  readonly log: PulseLogEntry[] = [];
  private readonly documents = new Map<string, FakeDocument>();
  private readonly channelRecords: ChannelRecord[] = [];
  private readonly area = new Map<string, string>();
  private queue: QueuedTask[] = [];
  private taskSeq = 0;
  private channelSeq = 0;

  constructor(origin = 'https://musixquare.com') {
    this.origin = new URL(origin).origin;
  }

  /**
   * Attach a window as a document of this origin and install its
   * `BroadcastChannel` and `localStorage`. `dispose()` restores the window's
   * previous properties.
   */
  attach(name: string, window: FakeRealmWindow, options: FakeDocumentOptions = {}): FakeDocument {
    if (this.documents.has(name)) throw new Error(`document ${name} is already attached`);
    if (window.location.origin !== this.origin) {
      throw new Error(`document ${name} is ${window.location.origin}, not ${this.origin}`);
    }
    const doc = new FakeDocument(this, name, window, options);
    this.documents.set(name, doc);
    return doc;
  }

  document(name: string): FakeDocument {
    const doc = this.documents.get(name);
    if (!doc) throw new Error(`no document named ${name}`);
    return doc;
  }

  /** A snapshot of the origin's shared localStorage area. */
  get storage(): ReadonlyMap<string, string> {
    return new Map(this.area);
  }

  /** A value stored before any of these documents existed: no storage event. */
  seedStorage(key: string, value: string): void {
    this.area.set(key, value);
  }

  /** Open BroadcastChannel objects of live documents, in creation order. */
  openChannels(
    name?: string,
  ): Array<{ readonly id: string; readonly doc: string; readonly name: string }> {
    return this.channelRecords
      .filter((record) => !record.closed && !record.doc.unloaded)
      .filter((record) => name === undefined || record.name === name)
      .map((record) => ({ id: record.id, doc: record.doc.name, name: record.name }));
  }

  pending(filter?: PulseTaskFilter): PulseTask[] {
    return this.queue.map((queued) => queued.task).filter((task) => matches(task, filter));
  }

  /** Delivered (not dropped) tasks from the log, optionally filtered. */
  deliveries(
    filter?: Partial<Pick<PulseTask, 'transport' | 'from' | 'to' | 'target'>>,
  ): DeliverEntry[] {
    return this.log.filter(
      (entry): entry is DeliverEntry =>
        entry.op === 'deliver' &&
        (!filter ||
          (Object.keys(filter) as Array<keyof typeof filter>).every(
            (key) => filter[key] === entry[key],
          )),
    );
  }

  /**
   * Run the first queued task that matches `filter`, synchronously. Throws when
   * nothing matches, when that task's document is held, or when running it
   * would overtake an earlier task in the same sender/target/transport lane.
   */
  deliverNext(filter?: PulseTaskFilter): PulseTask {
    const index = this.queue.findIndex((queued) => matches(queued.task, filter));
    if (index === -1) throw new Error('no queued pulse task matches the filter');
    const { task, run } = this.queue[index]!;
    const blocker = this.queue.slice(0, index).find((earlier) => sameLane(earlier.task, task));
    if (blocker) {
      throw new Error(
        `task ${task.id} would overtake task ${blocker.task.id} in the ` +
          `${task.transport} lane ${task.from} -> ${task.to}; engines keep that order`,
      );
    }
    if (this.documents.get(task.to)?.held) {
      throw new Error(`task ${task.id} targets ${task.to}, which is held`);
    }
    this.queue.splice(index, 1);
    run();
    return task;
  }

  /**
   * Run matching tasks one at a time, settling microtasks and pending I/O
   * after each, until none is runnable. Deliveries queued by a delivery run
   * too. Returns the tasks that ran.
   */
  async deliverAll(filter?: PulseTaskFilter): Promise<PulseTask[]> {
    const delivered: PulseTask[] = [];
    await this.settle();
    for (let guard = 0; guard <= 500; guard++) {
      const next = this.queue.find(
        (queued, index) =>
          matches(queued.task, filter) &&
          !this.documents.get(queued.task.to)?.held &&
          !this.queue.slice(0, index).some((earlier) => sameLane(earlier.task, queued.task)),
      );
      if (!next) return delivered;
      delivered.push(this.deliverNext((task) => task.id === next.task.id));
      await this.settle();
    }
    throw new Error('pulse deliveries did not quiesce');
  }

  /** Let microtasks and pending fetch/Response I/O run (real macrotask turns). */
  async settle(turns = 3): Promise<void> {
    for (let turn = 0; turn < turns; turn++) {
      await new Promise<void>((resolve) => {
        realSetImmediate(resolve);
      });
    }
  }

  /** Close every channel, drop every task and restore each window's properties. */
  dispose(): void {
    for (const doc of [...this.documents.values()].reverse()) doc.restoreGlobals();
    for (const record of this.channelRecords) record.closed = true;
    this.queue = [];
    this.documents.clear();
  }

  // ─── Internal: used by FakeDocument, the channel class and the storage view ───

  /** @internal */
  registerChannel(doc: FakeDocument, name: string, channel: EventTarget): ChannelRecord {
    const record: ChannelRecord = {
      id: `${doc.name}#${doc.nextChannelOrdinal()}`,
      seq: ++this.channelSeq,
      name,
      doc,
      channel,
      closed: false,
    };
    this.channelRecords.push(record);
    this.log.push({ op: 'open', doc: doc.name, channel: record.id, name });
    return record;
  }

  /** @internal */
  closeChannel(record: ChannelRecord): void {
    if (record.closed) return;
    record.closed = true;
    this.log.push({ op: 'close', doc: record.doc.name, channel: record.id, name: record.name });
  }

  /** @internal */
  post(source: ChannelRecord, message: unknown): void {
    // Eligibility comes before the closed flag: a gone document posts nothing and throws nothing.
    if (source.doc.unloaded) return;
    if (source.closed) {
      throw new source.doc.window.DOMException('BroadcastChannel is closed', 'InvalidStateError');
    }
    const serialized = structuredClone(message);
    const destinations = this.channelRecords
      .filter(
        (record) =>
          record !== source &&
          record.name === source.name &&
          !record.closed &&
          !record.doc.unloaded,
      )
      .sort((a, b) => a.seq - b.seq);
    this.log.push({
      op: 'post',
      doc: source.doc.name,
      channel: source.id,
      name: source.name,
      to: destinations.map((record) => record.id),
    });
    for (const destination of destinations) {
      this.enqueue(
        {
          transport: 'broadcast',
          from: source.doc.name,
          to: destination.doc.name,
          target: destination.id,
          key: source.name,
          data: serialized,
        },
        (task) => {
          if (destination.closed) {
            this.logDelivery('drop', task, 'closed');
            return;
          }
          this.logDelivery('deliver', task);
          destination.channel.dispatchEvent(
            new destination.doc.window.MessageEvent('message', {
              data: structuredClone(serialized),
              origin: this.origin,
            }),
          );
        },
      );
    }
  }

  /** @internal */
  storageGet(key: string): string | null {
    return this.area.get(key) ?? null;
  }

  /** @internal */
  storageKeys(): string[] {
    return [...this.area.keys()];
  }

  /** @internal */
  storageSet(writer: FakeDocument, key: string, value: string | null): void {
    const previous = this.area.get(key) ?? null;
    if (previous === value) {
      this.log.push({ op: 'storage-write', doc: writer.name, key, changed: false, to: [] });
      return;
    }
    if (value === null) this.area.delete(key);
    else this.area.set(key, value);
    this.queueStorageEvents(writer, key, previous, value);
  }

  /** @internal */
  storageClear(writer: FakeDocument): void {
    if (this.area.size === 0) {
      this.log.push({ op: 'storage-write', doc: writer.name, key: null, changed: false, to: [] });
      return;
    }
    this.area.clear();
    this.queueStorageEvents(writer, null, null, null);
  }

  /** @internal */
  postWindowMessage(
    source: FakeDocument,
    target: FakeDocument,
    message: unknown,
    targetOrigin: string,
  ): void {
    const sourceOrigin = source.origin.origin;
    const resolved =
      targetOrigin === '*'
        ? target.origin.origin
        : targetOrigin === '/'
          ? sourceOrigin
          : new URL(targetOrigin).origin;
    const accepted = resolved === target.origin.origin && !target.unloaded;
    this.log.push({
      op: 'window-post',
      from: source.name,
      to: target.name,
      targetOrigin,
      accepted,
    });
    if (!accepted) return;
    const serialized = structuredClone(message);
    const targetHub = target.origin;
    targetHub.enqueue(
      {
        transport: 'window-message',
        from: source.name,
        to: target.name,
        target: 'window',
        key: null,
        data: serialized,
      },
      (task) => {
        targetHub.logDelivery('deliver', task);
        const realm = target.window;
        realm.dispatchEvent(
          new realm.MessageEvent('message', {
            data: structuredClone(serialized),
            origin: sourceOrigin,
          }),
        );
      },
    );
  }

  /** @internal */
  dropTasksTo(doc: FakeDocument): void {
    const dropped = this.queue.filter((queued) => queued.task.to === doc.name);
    this.queue = this.queue.filter((queued) => queued.task.to !== doc.name);
    for (const queued of dropped) this.logDelivery('drop', queued.task, 'unloaded');
  }

  private queueStorageEvents(
    writer: FakeDocument,
    key: string | null,
    oldValue: string | null,
    newValue: string | null,
  ): void {
    const targets = [...this.documents.values()].filter(
      (doc) => doc !== writer && !doc.unloaded && doc.storageMode !== 'blocked',
    );
    this.log.push({
      op: 'storage-write',
      doc: writer.name,
      key,
      changed: true,
      to: targets.map((doc) => doc.name),
    });
    const url = writer.window.location.href;
    for (const target of targets) {
      this.enqueue(
        {
          transport: 'storage',
          from: writer.name,
          to: target.name,
          target: 'window',
          key,
          data: newValue,
        },
        (task) => {
          this.logDelivery('deliver', task);
          const realm = target.window;
          const event = new realm.StorageEvent('storage', { key, oldValue, newValue, url });
          // jsdom's StorageEvent accepts only its own Storage; no consumer reads storageArea.
          Object.defineProperty(event, 'storageArea', { value: target.localStorage });
          realm.dispatchEvent(event);
        },
      );
    }
  }

  private enqueue(fields: Omit<PulseTask, 'id'>, run: (task: PulseTask) => void): void {
    const task: PulseTask = { id: ++this.taskSeq, ...fields };
    this.queue.push({ task, run: () => run(task) });
  }

  private logDelivery(op: 'deliver' | 'drop', task: PulseTask, reason?: 'closed' | 'unloaded') {
    this.log.push({
      op,
      task: task.id,
      transport: task.transport,
      from: task.from,
      to: task.to,
      target: task.target,
      ...(reason ? { reason } : {}),
    });
  }
}

/** One document of a FakeOrigin. */
export class FakeDocument {
  readonly origin: FakeOrigin;
  readonly name: string;
  readonly window: FakeRealmWindow;
  readonly storageMode: FakeStorageMode;
  /** The BroadcastChannel constructor installed in this document, or undefined. */
  readonly BroadcastChannel: typeof BroadcastChannel | undefined;
  readonly localStorage: Storage;
  held = false;
  unloaded = false;
  private channelOrdinal = 0;
  private readonly restorers: Array<() => void> = [];

  constructor(
    origin: FakeOrigin,
    name: string,
    window: FakeRealmWindow,
    options: FakeDocumentOptions,
  ) {
    this.origin = origin;
    this.name = name;
    this.window = window;
    this.storageMode = options.storage ?? 'available';
    this.BroadcastChannel =
      options.broadcastChannel === false ? undefined : createBroadcastChannelClass(this);
    this.localStorage = createStorageView(this);
    this.install('BroadcastChannel', { value: this.BroadcastChannel, writable: true });
    const storage = this.localStorage;
    const blocked = this.storageMode === 'blocked';
    const realm = window;
    this.install('localStorage', {
      get() {
        if (blocked) throw new realm.DOMException('localStorage is blocked', 'SecurityError');
        return storage;
      },
    });
  }

  /** Keep this document's deliveries queued (a backgrounded or frozen tab). */
  hold(): void {
    this.held = true;
  }

  release(): void {
    this.held = false;
  }

  /**
   * The document goes away. Its channels stop being eligible (no 'close' entry:
   * nothing called close()), its queued deliveries are dropped, its posts do
   * nothing and it receives nothing more.
   */
  unload(): void {
    if (this.unloaded) return;
    this.unloaded = true;
    this.origin.dropTasksTo(this);
    this.origin.log.push({ op: 'unload', doc: this.name });
  }

  /** A WindowProxy-like handle through which this document posts to `target` (an opener). */
  windowProxy(target: FakeDocument): FakeWindowProxy {
    return {
      postMessage: (message: unknown, targetOrigin = '/') => {
        this.origin.postWindowMessage(this, target, message, targetOrigin);
      },
    };
  }

  /** @internal */
  nextChannelOrdinal(): number {
    return ++this.channelOrdinal;
  }

  /** @internal */
  restoreGlobals(): void {
    for (const restore of this.restorers.splice(0).reverse()) restore();
  }

  private install(key: 'BroadcastChannel' | 'localStorage', descriptor: PropertyDescriptor): void {
    const target = this.window as unknown as Record<string, unknown>;
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, enumerable: true, ...descriptor });
    this.restorers.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else delete target[key];
    });
  }
}

function createBroadcastChannelClass(doc: FakeDocument): typeof BroadcastChannel {
  class FakeBroadcastChannel extends doc.window.EventTarget {
    readonly name: string;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    readonly #record: ChannelRecord;
    #onmessage: ((event: MessageEvent) => void) | null = null;
    #onmessageListener: ((event: Event) => void) | null = null;

    constructor(name: string) {
      super();
      this.name = String(name);
      this.#record = doc.origin.registerChannel(doc, this.name, this);
    }

    get onmessage(): ((event: MessageEvent) => void) | null {
      return this.#onmessage;
    }

    set onmessage(handler: ((event: MessageEvent) => void) | null) {
      if (this.#onmessageListener) this.removeEventListener('message', this.#onmessageListener);
      this.#onmessage = typeof handler === 'function' ? handler : null;
      this.#onmessageListener = null;
      const current = this.#onmessage;
      if (current) {
        this.#onmessageListener = (event: Event) => current.call(this, event as MessageEvent);
        this.addEventListener('message', this.#onmessageListener);
      }
    }

    postMessage(message: unknown): void {
      doc.origin.post(this.#record, message);
    }

    close(): void {
      doc.origin.closeChannel(this.#record);
    }
  }
  return FakeBroadcastChannel as unknown as typeof BroadcastChannel;
}

function createStorageView(doc: FakeDocument): Storage {
  const origin = doc.origin;
  const view = {
    get length(): number {
      return origin.storageKeys().length;
    },
    key(index: number): string | null {
      return origin.storageKeys()[index] ?? null;
    },
    getItem(key: string): string | null {
      return origin.storageGet(String(key));
    },
    setItem(key: string, value: string): void {
      if (doc.storageMode === 'quota-exceeded') {
        throw new doc.window.DOMException('localStorage quota exceeded', 'QuotaExceededError');
      }
      origin.storageSet(doc, String(key), String(value));
    },
    removeItem(key: string): void {
      origin.storageSet(doc, String(key), null);
    },
    clear(): void {
      origin.storageClear(doc);
    },
  };
  return view as unknown as Storage;
}
