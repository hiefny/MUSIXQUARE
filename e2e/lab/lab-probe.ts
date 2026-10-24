/**
 * Passive page probe for the lab. It wraps native objects only to watch them:
 * wrapped functions keep their receiver, arguments, return value and throws.
 * Nothing here sends a product message, writes product state, dispatches an
 * event or changes RTC/ICE/SDP configuration. SDP text and payloads are never
 * kept; frames are reduced to their type and transfer identity.
 */
import type { Page } from '@playwright/test';

export interface FrameRow {
  readonly at: number;
  readonly dir: 'send' | 'recv';
  readonly pc: number;
  readonly channel: string;
  readonly type: string | null;
  readonly kind?: string;
  readonly epoch?: number;
  readonly index?: number;
  readonly queueItemId?: string;
  readonly sessionId?: string;
  readonly restart?: boolean;
  readonly startChunk?: number;
  readonly payloadBytes: number;
}

export interface PcEventRow {
  readonly at: number;
  readonly pc: number;
  readonly event: string;
  readonly connectionState: string;
  readonly iceConnectionState: string;
}

export interface BusRow {
  readonly at: number;
  readonly name: string;
  readonly detail: string | null;
}

export interface WsRow {
  readonly at: number;
  readonly socket: number;
  readonly dir: 'create' | 'open' | 'close' | 'send' | 'recv';
  readonly type: string | null;
  readonly code?: number;
}

export interface DomRow {
  readonly at: number;
  readonly dialogs: string[];
}

export interface ProbeExport {
  readonly frames: FrameRow[];
  readonly pcEvents: PcEventRow[];
  readonly bus: BusRow[];
  readonly ws: WsRow[];
  readonly dom: DomRow[];
  readonly dropped: number;
  readonly errors: string[];
}

/** Bus events that tell a logical close or a recovery apart. */
const WATCHED_BUS_EVENTS = [
  'network:error',
  'network:peer-disconnected',
  'network:peer-ice-recovered',
  'player:stop-all-media',
  'system-audio:force-stop',
];

export async function installLabProbe(page: Page): Promise<void> {
  await page.addInitScript((watched: string[]) => {
    const w = window as any;
    const LIMIT = 60_000;
    const probe: any = (w.__labProbe = {
      frames: [],
      pcEvents: [],
      bus: [],
      ws: [],
      dom: [],
      dropped: 0,
      errors: [],
    });
    const put = (kind: string, row: unknown) => {
      if (probe[kind].length >= LIMIT) probe.dropped++;
      else probe[kind].push(row);
    };
    const guard = (where: string, fn: () => void) => {
      try {
        fn();
      } catch (error) {
        if (probe.errors.length < 100) probe.errors.push(`${where}: ${String(error)}`);
      }
    };

    // Object identities, so a snapshot can tell "the same connection" apart.
    const ids = new WeakMap<object, number>();
    let nextId = 1;
    probe.identity = (value: unknown) => {
      if (!value || typeof value !== 'object') return null;
      let id = ids.get(value);
      if (!id) ids.set(value, (id = nextId++));
      return id;
    };

    const decoder = new TextDecoder();
    const summarize = (frame: any, payloadBytes: number) => {
      const row: any = { type: typeof frame?.type === 'string' ? frame.type : null, payloadBytes };
      if (row.type === 'mxqr-control-isolation') {
        row.kind = frame.kind;
        if (typeof frame.epoch === 'number') row.epoch = frame.epoch;
      }
      const index = frame?.chunkIndex ?? frame?.index;
      if (typeof index === 'number') row.index = index;
      if (typeof frame?.queueItemId === 'string') row.queueItemId = frame.queueItemId;
      if (frame?.sessionId != null) row.sessionId = String(frame.sessionId);
      if (typeof frame?.restart === 'boolean') row.restart = frame.restart;
      if (typeof frame?.startChunk === 'number') row.startChunk = frame.startChunk;
      return row;
    };
    const decode = (data: unknown) => {
      if (typeof data === 'string') return summarize(JSON.parse(data), 0);
      if (data instanceof ArrayBuffer && data.byteLength >= 4) {
        const headerBytes = new DataView(data).getUint32(0, false);
        const header = JSON.parse(decoder.decode(new Uint8Array(data, 4, headerBytes)));
        return summarize(header, data.byteLength - 4 - headerBytes);
      }
      return { type: null, payloadBytes: 0 };
    };

    const channels = new WeakSet<RTCDataChannel>();
    const observeChannel = (channel: RTCDataChannel, pc: number) => {
      if (channels.has(channel)) return;
      channels.add(channel);
      const send = channel.send;
      channel.send = function (this: RTCDataChannel, ...args: any[]) {
        guard('send', () =>
          put('frames', {
            at: Date.now(),
            dir: 'send',
            pc,
            channel: channel.label,
            ...decode(args[0]),
          }),
        );
        return Reflect.apply(send, this, args);
      } as typeof channel.send;
      channel.addEventListener('message', (event) =>
        guard('recv', () =>
          put('frames', {
            at: Date.now(),
            dir: 'recv',
            pc,
            channel: channel.label,
            ...decode(event.data),
          }),
        ),
      );
    };

    const NativePeerConnection = window.RTCPeerConnection;
    w.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
        guard('pc', () => {
          const id = probe.identity(pc);
          const create = pc.createDataChannel;
          pc.createDataChannel = function (this: RTCPeerConnection, ...a: any[]) {
            const channel = Reflect.apply(create, this, a) as RTCDataChannel;
            guard('channel', () => observeChannel(channel, id));
            return channel;
          } as typeof pc.createDataChannel;
          pc.addEventListener('datachannel', (event) =>
            guard('datachannel', () => observeChannel(event.channel, id)),
          );
          for (const event of ['connectionstatechange', 'iceconnectionstatechange']) {
            pc.addEventListener(event, () =>
              put('pcEvents', {
                at: Date.now(),
                pc: id,
                event,
                connectionState: pc.connectionState,
                iceConnectionState: pc.iceConnectionState,
              }),
            );
          }
        });
        return pc;
      },
    });

    const NativeWebSocket = window.WebSocket;
    const wsType = (data: unknown) => {
      if (typeof data !== 'string') return null;
      try {
        const value = JSON.parse(data);
        return typeof value?.type === 'string' ? value.type : null;
      } catch {
        return null;
      }
    };
    w.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        guard('ws', () => {
          const id = probe.identity(socket);
          put('ws', { at: Date.now(), socket: id, dir: 'create', type: null });
          socket.addEventListener('open', () =>
            put('ws', { at: Date.now(), socket: id, dir: 'open', type: null }),
          );
          socket.addEventListener('close', (event) =>
            put('ws', { at: Date.now(), socket: id, dir: 'close', type: null, code: event.code }),
          );
          socket.addEventListener('message', (event) =>
            put('ws', { at: Date.now(), socket: id, dir: 'recv', type: wsType(event.data) }),
          );
          const send = socket.send;
          socket.send = function (this: WebSocket, ...a: any[]) {
            guard('ws-send', () =>
              put('ws', { at: Date.now(), socket: id, dir: 'send', type: wsType(a[0]) }),
            );
            return Reflect.apply(send, this, a);
          } as typeof socket.send;
        });
        return socket;
      },
    });

    const detail = (value: unknown) => {
      if (value == null) return null;
      if (typeof value === 'string') return value.slice(0, 200);
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const text = record.type ?? record.message ?? record.peer ?? null;
        return text == null ? null : String(text).slice(0, 200);
      }
      return String(value);
    };
    const attachBus = () => {
      const bus = w.__MUSIXQUARE_BUS__;
      if (!bus || typeof bus.on !== 'function') return false;
      for (const name of watched) {
        bus.on(name, (value: unknown) =>
          put('bus', { at: Date.now(), name, detail: detail(value) }),
        );
      }
      return true;
    };
    if (!attachBus()) {
      const timer = setInterval(() => {
        if (attachBus()) clearInterval(timer);
      }, 20);
    }

    // Visible dialogs and overlays, as a change log.
    let lastDom = '';
    setInterval(
      () =>
        guard('dom', () => {
          const dialogs: string[] = [];
          for (const element of document.querySelectorAll(
            '#dialog-overlay, .signaling-recovery-overlay, .session-reset-overlay',
          )) {
            const style = getComputedStyle(element);
            const shown =
              (element.classList.contains('show') || element.classList.contains('active')) &&
              style.display !== 'none' &&
              style.visibility !== 'hidden';
            if (shown) dialogs.push((element.textContent ?? '').replace(/\s+/g, ' ').trim());
          }
          const signature = JSON.stringify(dialogs);
          if (signature !== lastDom) {
            lastDom = signature;
            put('dom', { at: Date.now(), dialogs });
          }
        }),
      250,
    );

    probe.export = () => ({
      frames: probe.frames,
      pcEvents: probe.pcEvents,
      bus: probe.bus,
      ws: probe.ws,
      dom: probe.dom,
      dropped: probe.dropped,
      errors: probe.errors,
    });
  }, WATCHED_BUS_EVENTS);
}

export function readProbe(page: Page): Promise<ProbeExport> {
  return page.evaluate(() => (window as any).__labProbe.export() as ProbeExport);
}
