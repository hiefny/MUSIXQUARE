/** @vitest-environment jsdom */
/**
 * Calibration of the C8 same-origin fake (structural plan C8, Phase 0c) against
 * the HTML Standard rules quoted in __helpers__/fake-broadcast-channel.ts. The
 * account pulse suites trust these semantics, so each rule they rely on is
 * checked here on plain JSDOM documents with no app code involved.
 */
import { JSDOM, type DOMWindow } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeOrigin,
  type FakeDocument,
  type FakeDocumentOptions,
  type FakeRealmWindow,
} from './__helpers__/fake-broadcast-channel.ts';

const ORIGIN = 'https://musixquare.com';
const windows: DOMWindow[] = [];
const origins: FakeOrigin[] = [];

function createOrigin(url = ORIGIN): FakeOrigin {
  const origin = new FakeOrigin(url);
  origins.push(origin);
  return origin;
}

function openDocument(
  origin: FakeOrigin,
  name: string,
  options: FakeDocumentOptions = {},
): { doc: FakeDocument; window: DOMWindow } {
  // runScripts gives each window its own global, so eval() runs inside that document.
  const dom = new JSDOM('<!doctype html>', {
    url: `${origin.origin}/${name}`,
    runScripts: 'outside-only',
  });
  windows.push(dom.window);
  const doc = origin.attach(name, dom.window as unknown as FakeRealmWindow, options);
  return { doc, window: dom.window };
}

function channel(doc: FakeDocument, name: string): BroadcastChannel {
  return new doc.BroadcastChannel!(name);
}

function record(target: EventTarget, into: unknown[], label?: string): void {
  target.addEventListener('message', (event) => {
    const message = event as MessageEvent;
    into.push(label ? [label, message.data, message.origin] : message.data);
  });
}

afterEach(() => {
  for (const origin of origins.splice(0)) origin.dispose();
  for (const window of windows.splice(0)) window.close();
});

describe('BroadcastChannel delivery', () => {
  it('queues one task per other same-name object of the origin, never the sender', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a').doc;
    const b = openDocument(origin, 'b').doc;
    const sender = channel(a, 'pulse');
    const sameDocument = channel(a, 'pulse');
    const otherDocument = channel(b, 'pulse');
    const otherName = channel(b, 'other');
    const received: unknown[] = [];
    record(sender, received, 'a#1');
    record(sameDocument, received, 'a#2');
    record(otherDocument, received, 'b#1');
    record(otherName, received, 'b#2');

    sender.postMessage({ n: 1 });

    // Never synchronous: nothing has run yet.
    expect(received).toEqual([]);
    expect(origin.pending().map((task) => task.target)).toEqual(['a#2', 'b#1']);
    expect(origin.log.at(-1)).toEqual({
      op: 'post',
      doc: 'a',
      channel: 'a#1',
      name: 'pulse',
      to: ['a#2', 'b#1'],
    });

    await origin.deliverAll();

    expect(received).toEqual([
      ['a#2', { n: 1 }, ORIGIN],
      ['b#1', { n: 1 }, ORIGIN],
    ]);
  });

  // The HTML Standard fixes creation order only among objects of one agent
  // (one document here: a#1 before a#3, whatever happens between them). The
  // order across documents is implementation-defined; global creation order
  // is the fake's chosen interleaving, which this test also pins.
  it('sorts destinations in creation order: required within a document, chosen across documents', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a').doc;
    const b = openDocument(origin, 'b').doc;
    const c = openDocument(origin, 'c').doc;
    const order: string[] = [];
    const listen = (target: BroadcastChannel, id: string) =>
      target.addEventListener('message', () => order.push(id));
    listen(channel(c, 'pulse'), 'c#1');
    listen(channel(b, 'pulse'), 'b#1');
    listen(channel(a, 'pulse'), 'a#1');
    const sender = channel(a, 'pulse');
    listen(channel(a, 'pulse'), 'a#3');

    sender.postMessage('x');
    await origin.deliverAll();

    expect(order.filter((id) => id.startsWith('a#'))).toEqual(['a#1', 'a#3']);
    expect(order).toEqual(['c#1', 'b#1', 'a#1', 'a#3']);
  });

  it('runs each delivery as its own task, with microtasks settled in between', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a').doc;
    const b = openDocument(origin, 'b').doc;
    const order: string[] = [];
    channel(b, 'pulse').addEventListener('message', () => {
      order.push('first listener');
      queueMicrotask(() => order.push('first microtask'));
    });
    channel(b, 'pulse').addEventListener('message', () => order.push('second listener'));

    channel(a, 'pulse').postMessage('x');
    await origin.deliverAll();

    expect(order).toEqual(['first listener', 'first microtask', 'second listener']);
  });

  it('supports onmessage and its replacement', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a').doc;
    const b = openDocument(origin, 'b').doc;
    const receiver = channel(b, 'pulse');
    const calls: string[] = [];
    receiver.onmessage = () => calls.push('first');
    receiver.onmessage = (event) => calls.push(`second:${String(event.data)}`);

    channel(a, 'pulse').postMessage('x');
    await origin.deliverAll();
    receiver.onmessage = null;
    channel(a, 'pulse').postMessage('y');
    await origin.deliverAll();

    expect(calls).toEqual(['second:x']);
  });

  it('delivers a message posted just before the sender closed and skips a receiver closed before its task', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a').doc;
    const b = openDocument(origin, 'b').doc;
    const c = openDocument(origin, 'c').doc;
    const received: unknown[] = [];
    const open = channel(b, 'pulse');
    const closing = channel(c, 'pulse');
    record(open, received, 'b');
    record(closing, received, 'c');
    const sender = channel(a, 'pulse');

    sender.postMessage('last words');
    sender.close();
    closing.close();
    await origin.deliverAll();

    expect(received).toEqual([['b', 'last words', ORIGIN]]);
    expect(origin.log.filter((entry) => entry.op === 'drop')).toEqual([
      expect.objectContaining({ to: 'c', target: 'c#1', reason: 'closed' }),
    ]);
    let thrown: unknown;
    try {
      sender.postMessage('after close');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as DOMException).name).toBe('InvalidStateError');
    expect(origin.pending()).toEqual([]);
  });

  it('does not buffer for objects created after the post', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a').doc;
    const b = openDocument(origin, 'b').doc;
    channel(a, 'pulse').postMessage('early');
    const late: unknown[] = [];
    record(channel(b, 'pulse'), late);

    await origin.deliverAll();

    expect(late).toEqual([]);
  });

  it('gives each destination its own structured clone', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a').doc;
    const b = openDocument(origin, 'b').doc;
    const seen: Array<{ items: number[] }> = [];
    const mutate = channel(b, 'pulse');
    mutate.addEventListener('message', (event) => {
      const data = (event as MessageEvent).data as { items: number[] };
      data.items.push(99);
      seen.push(data);
    });
    channel(b, 'pulse').addEventListener('message', (event) => {
      seen.push((event as MessageEvent).data as { items: number[] });
    });
    const payload = { items: [1] };
    const sender = channel(a, 'pulse');

    sender.postMessage(payload);
    payload.items.push(2);
    await origin.deliverAll();

    expect(seen).toEqual([{ items: [1, 99] }, { items: [1] }]);
    let thrown: unknown;
    try {
      sender.postMessage({ run: () => undefined });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as DOMException).name).toBe('DataCloneError');
  });

  it('leaves BroadcastChannel undefined in a document configured without it', () => {
    const origin = createOrigin();
    const { window } = openDocument(origin, 'legacy', { broadcastChannel: false });
    expect(window.eval('typeof BroadcastChannel')).toBe('undefined');
  });
});

describe('storage events', () => {
  it('queues a storage event for every other document and never for the writer', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a');
    const b = openDocument(origin, 'b');
    const c = openDocument(origin, 'c');
    const events: Array<[string, string | null, string | null, string | null, string]> = [];
    for (const [label, window] of [
      ['a', a.window],
      ['b', b.window],
      ['c', c.window],
    ] as const) {
      window.addEventListener('storage', (event) => {
        events.push([label, event.key, event.oldValue, event.newValue, event.url]);
        expect(event.storageArea).toBe(origin.document(label).localStorage);
      });
    }

    a.window.eval("localStorage.setItem('k', 'one')");
    expect(events).toEqual([]);
    await origin.deliverAll();
    a.window.eval("localStorage.setItem('k', 'two')");
    await origin.deliverAll();

    expect(events).toEqual([
      ['b', 'k', null, 'one', `${ORIGIN}/a`],
      ['c', 'k', null, 'one', `${ORIGIN}/a`],
      ['b', 'k', 'one', 'two', `${ORIGIN}/a`],
      ['c', 'k', 'one', 'two', `${ORIGIN}/a`],
    ]);
    expect(b.window.eval("localStorage.getItem('k')")).toBe('two');
  });

  it('fires nothing for an unchanged value, an absent key or an empty clear', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a');
    const b = openDocument(origin, 'b');
    const events: Array<[string | null, string | null]> = [];
    b.window.addEventListener('storage', (event) => events.push([event.key, event.newValue]));

    a.doc.localStorage.clear();
    a.doc.localStorage.removeItem('absent');
    a.doc.localStorage.setItem('k', 'same');
    await origin.deliverAll();
    a.doc.localStorage.setItem('k', 'same');
    a.doc.localStorage.removeItem('k');
    a.doc.localStorage.setItem('other', 'x');
    a.doc.localStorage.clear();
    await origin.deliverAll();

    expect(events).toEqual([
      ['k', 'same'],
      ['k', null],
      ['other', 'x'],
      [null, null],
    ]);
  });

  it('blocks access in a blocked document and rejects writes when the quota is exceeded', async () => {
    const origin = createOrigin();
    const writer = openDocument(origin, 'writer');
    const blocked = openDocument(origin, 'blocked', { storage: 'blocked' });
    const full = openDocument(origin, 'full', { storage: 'quota-exceeded' });
    const blockedEvents: unknown[] = [];
    blocked.window.addEventListener('storage', (event) => blockedEvents.push(event));

    expect(() => blocked.window.eval('localStorage')).toThrow(/blocked/);
    expect(() => full.window.eval("localStorage.setItem('k', 'v')")).toThrow(/quota/);
    writer.doc.localStorage.setItem('k', 'v');
    await origin.deliverAll();

    expect(blockedEvents).toEqual([]);
    expect(full.window.eval("localStorage.getItem('k')")).toBe('v');
  });
});

describe('window messages', () => {
  it('applies the targetOrigin check and reports the sender origin', async () => {
    const origin = createOrigin();
    const popup = openDocument(origin, 'popup').doc;
    const opener = openDocument(origin, 'opener');
    const other = createOrigin('https://other.example');
    const foreign = openDocument(other, 'foreign').doc;
    const messages: Array<[unknown, string]> = [];
    opener.window.addEventListener('message', (event) => messages.push([event.data, event.origin]));

    popup.windowProxy(opener.doc).postMessage('same-origin', '/');
    popup.windowProxy(opener.doc).postMessage('wrong target', 'https://elsewhere.example');
    foreign.windowProxy(opener.doc).postMessage('cross-origin', '*');
    await origin.deliverAll();

    expect(messages).toEqual([
      ['same-origin', ORIGIN],
      ['cross-origin', 'https://other.example'],
    ]);
    expect(
      origin.log
        .concat(other.log)
        .filter((entry) => entry.op === 'window-post')
        .map((entry) => (entry.op === 'window-post' ? entry.accepted : null)),
    ).toEqual([true, false, true]);
  });
});

describe('ordering, holding and unloading', () => {
  it('lets a storage event overtake a broadcast but never a task in the same lane', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a').doc;
    const b = openDocument(origin, 'b');
    const order: string[] = [];
    channel(b.doc, 'pulse').addEventListener('message', (event) =>
      order.push(`broadcast:${String((event as MessageEvent).data)}`),
    );
    b.window.addEventListener('storage', (event) => order.push(`storage:${event.newValue}`));
    const sender = channel(a, 'pulse');

    sender.postMessage('1');
    sender.postMessage('2');
    a.localStorage.setItem('k', 'v');

    expect(() => origin.deliverNext((task) => task.data === '2')).toThrow(/overtake task/);
    origin.deliverNext({ transport: 'storage' });
    await origin.deliverAll();

    expect(order).toEqual(['storage:v', 'broadcast:1', 'broadcast:2']);
  });

  it('keeps a held document’s deliveries queued until release', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a').doc;
    const b = openDocument(origin, 'b').doc;
    const c = openDocument(origin, 'c').doc;
    const received: string[] = [];
    channel(b, 'pulse').addEventListener('message', () => received.push('b'));
    channel(c, 'pulse').addEventListener('message', () => received.push('c'));

    b.hold();
    channel(a, 'pulse').postMessage('x');
    await origin.deliverAll();
    expect(received).toEqual(['c']);
    expect(() => origin.deliverNext({ to: 'b' })).toThrow(/held/);
    expect(origin.pending({ to: 'b' })).toHaveLength(1);

    b.release();
    await origin.deliverAll();
    expect(received).toEqual(['c', 'b']);
  });

  it('drops an unloaded document’s queued deliveries, ignores its posts and skips it afterwards', async () => {
    const origin = createOrigin();
    const a = openDocument(origin, 'a').doc;
    const b = openDocument(origin, 'b').doc;
    const received: string[] = [];
    const fromB = channel(b, 'pulse');
    channel(b, 'pulse').addEventListener('message', () => received.push('b'));
    channel(a, 'pulse').addEventListener('message', () => received.push('a'));

    channel(a, 'pulse').postMessage('x');
    b.unload();
    // A gone document is not eligible for messaging: no throw, no delivery.
    fromB.postMessage('from the unloaded document');
    a.localStorage.setItem('k', 'v');
    await origin.deliverAll();

    // Only the sender's own document still listens.
    expect(received).toEqual(['a']);
    expect(origin.openChannels('pulse').map((open) => open.doc)).toEqual(['a', 'a']);
    expect(origin.log.filter((entry) => entry.op === 'close')).toEqual([]);
    expect(origin.log.filter((entry) => entry.op === 'drop')).toEqual([
      expect.objectContaining({ to: 'b', target: 'b#1', reason: 'unloaded' }),
      expect.objectContaining({ to: 'b', target: 'b#2', reason: 'unloaded' }),
    ]);
    expect(origin.log.filter((entry) => entry.op === 'storage-write')).toEqual([
      expect.objectContaining({ doc: 'a', changed: true, to: [] }),
    ]);
  });
});

describe('the Vitest jsdom global as a document', () => {
  it('installs and restores BroadcastChannel and localStorage on the global window', async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
    const localStorageBefore = window.localStorage;
    const origin = new FakeOrigin(window.location.origin);
    const global = origin.attach('global', window as unknown as FakeRealmWindow);
    const dom = new JSDOM('<!doctype html>', { url: `${window.location.origin}/other` });
    windows.push(dom.window);
    const other = origin.attach('other', dom.window as unknown as FakeRealmWindow);
    const received: unknown[] = [];
    record(new BroadcastChannel('pulse'), received);

    new other.BroadcastChannel!('pulse').postMessage('to the global document');
    other.localStorage.setItem('k', 'v');
    const storageEvents: Array<string | null> = [];
    window.addEventListener('storage', (event) => storageEvents.push(event.newValue), {
      once: true,
    });
    await origin.deliverAll();

    expect(received).toEqual(['to the global document']);
    expect(storageEvents).toEqual(['v']);
    expect(window.localStorage).toBe(global.localStorage);
    origin.dispose();
    expect(Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')).toEqual(before);
    expect(window.localStorage).toBe(localStorageBefore);
  });
});
