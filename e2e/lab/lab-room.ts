/**
 * Two-context Standard room over the local Cloudflare signaling Worker, driven
 * through the real setup and player UI. The guest page's P2P path can be cut and
 * restored; the host page is never shaped. Reads use the E2E state hooks only.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { waitForBootstrapReady } from '../helpers/bootstrap.ts';
import { useAnonymousAccountSession } from '../helpers/context-factory.ts';
import { isBenignPageError } from '../helpers/page-errors.ts';
import { LAB_SIGNALING_URL } from './lab-env.ts';
import { installLabProbe, readProbe, type ProbeExport } from './lab-probe.ts';
import { H8_PROFILE, primeP2PShaping, type P2PShaping } from './p2p-shaping.ts';

export interface ConsoleRow {
  readonly at: number;
  readonly type: string;
  readonly text: string;
}

export interface LabPage {
  readonly label: 'host' | 'guest';
  readonly context: BrowserContext;
  readonly page: Page;
  readonly console: ConsoleRow[];
  readonly pageErrors: string[];
}

export interface ConnectionSnapshot {
  readonly peerId: string;
  readonly connection: number | null;
  readonly open: boolean;
  readonly originalPc: number | null;
  readonly pcState: string | null;
  readonly bulk: string | null;
  readonly control: string | null;
  readonly isolationPhase: string | null;
  readonly sidePc: number | null;
  readonly sidePcState: string | null;
  readonly sideChannel: string | null;
}

export interface WavFixture {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

const CONSOLE_LIMIT = 20_000;

/**
 * Deterministic 16-bit PCM WAV. `seconds` keeps the whole scenario inside one
 * track; the sample rate and channels set the size (and so the transfer time).
 */
export async function writeWavFixture(
  path: string,
  seconds: number,
  sampleRate: number,
  channels: number,
  toneHz: number,
): Promise<WavFixture> {
  const frames = seconds * sampleRate;
  const dataBytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(2_000 * Math.sin((2 * Math.PI * toneHz * frame) / sampleRate));
    for (let channel = 0; channel < channels; channel++) {
      buffer.writeInt16LE(sample, 44 + (frame * channels + channel) * 2);
    }
  }
  await writeFile(path, buffer);
  return {
    path,
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

async function openLabPage(
  browser: Browser,
  label: 'host' | 'guest',
): Promise<{ lab: LabPage; shaping: P2PShaping | null }> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const lab: LabPage = { label, context, page, console: [], pageErrors: [] };
  page.on('console', (message) => {
    if (lab.console.length < CONSOLE_LIMIT) {
      lab.console.push({ at: Date.now(), type: message.type(), text: message.text() });
    }
  });
  page.on('pageerror', (error) => {
    if (!isBenignPageError(error)) lab.pageErrors.push(String(error));
  });
  // The guest's shaping session must exist before any RTCPeerConnection does.
  const shaping = label === 'guest' ? await primeP2PShaping(page, H8_PROFILE) : null;
  await page.addInitScript((signalingUrl) => {
    const w = window as unknown as Record<string, unknown>;
    w.__MUSIXQUARE_TRANSPORT__ = { provider: 'cloudflare', signalingUrl };
    try {
      localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
      localStorage.setItem('musixquare-app-used-v1', '1');
      // The release-record evidence lines are info level (device sessions set the same key).
      localStorage.setItem('mxqr:logLevel', 'info');
    } catch {
      // Opaque documents have no storage.
    }
  }, LAB_SIGNALING_URL);
  await installLabProbe(page);
  await useAnonymousAccountSession(page);
  return { lab, shaping };
}

async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await waitForBootstrapReady(page);
  await page.waitForSelector('#btn-setup-host', { state: 'visible', timeout: 15_000 });
}

async function waitSetupClosed(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(
    () => !document.getElementById('setup-overlay')?.classList.contains('active'),
    undefined,
    { timeout },
  );
}

export class LabRoom {
  readonly marks: Record<string, number> = {};
  readonly notes: Record<string, unknown> = {};

  private constructor(
    readonly host: LabPage,
    readonly guest: LabPage,
    readonly shaping: P2PShaping,
  ) {}

  /** Host creates a room through the setup UI; the guest joins with its code. No retries. */
  static async open(browser: Browser): Promise<LabRoom> {
    const host = await openLabPage(browser, 'host');
    const guest = await openLabPage(browser, 'guest');
    const room = new LabRoom(host.lab, guest.lab, guest.shaping!);

    await openSetup(room.host.page);
    await room.host.page.click('#btn-setup-host');
    await room.host.page.waitForFunction(
      () =>
        /^\d{6}$/.test(
          (document.getElementById('setup-code') as HTMLInputElement | null)?.value ?? '',
        ),
      undefined,
      { timeout: 20_000 },
    );
    const code = await room.host.page.locator('#setup-code').inputValue();
    await room.host.page.click('#btn-setup-confirm:not([disabled])');
    await waitSetupClosed(room.host.page, 20_000);

    await openSetup(room.guest.page);
    await room.guest.page.click('#btn-setup-guest');
    await room.guest.page.fill('#setup-join-code', code);
    await room.guest.page.click('#btn-setup-confirm');
    await waitSetupClosed(room.guest.page, 30_000);

    for (const page of [room.host.page, room.guest.page]) {
      await page.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          const host = get('network.hostConn');
          const peers = (get('network.connectedPeers') ?? []).filter((p: any) => p.conn);
          const connections = host
            ? [host, ...peers.map((p: any) => p.conn)]
            : peers.map((p: any) => p.conn);
          return connections.length === 1 && connections[0].open;
        },
        undefined,
        { timeout: 45_000 },
      );
    }
    room.mark('connected');
    return room;
  }

  mark(name: string): number {
    this.marks[name] = Date.now();
    return this.marks[name];
  }

  async cut(): Promise<number> {
    const record = await this.shaping.set(true, 'cut');
    this.marks.cut = record.returnedAt;
    return record.returnedAt;
  }

  async restore(): Promise<number> {
    const record = await this.shaping.set(false, 'restore');
    this.marks.restore = record.returnedAt;
    return record.returnedAt;
  }

  /** Each page's logical connections with their original and side routes. */
  connections(page: Page): Promise<ConnectionSnapshot[]> {
    return page.evaluate(() => {
      const w = window as any;
      const get = w.__MUSIXQUARE_GET_STATE__;
      const id = w.__labProbe.identity;
      const host = get('network.hostConn');
      const list = [
        ...(host ? [{ peerId: host.peer, conn: host }] : []),
        ...(get('network.connectedPeers') ?? [])
          .filter((p: any) => p.conn)
          .map((p: any) => ({ peerId: p.id, conn: p.conn })),
      ];
      return list.map(({ peerId, conn }: any) => {
        const isolation = conn.controlIsolation;
        return {
          peerId,
          connection: id(conn),
          open: !!conn.open,
          originalPc: id(conn.peerConnection),
          pcState: conn.peerConnection?.connectionState ?? null,
          bulk: conn.dataChannel?.readyState ?? null,
          control: conn.controlChannel?.readyState ?? null,
          isolationPhase: isolation?.phase ?? null,
          sidePc: id(isolation?.peerConnection),
          sidePcState: isolation?.peerConnection?.connectionState ?? null,
          sideChannel: isolation?.channel?.readyState ?? null,
        };
      });
    });
  }

  async only(page: Page): Promise<ConnectionSnapshot> {
    const list = await this.connections(page);
    if (list.length !== 1) throw new Error(`Expected one logical connection, saw ${list.length}`);
    return list[0]!;
  }

  /** Host adds one local file through the real file input; resolves its queue item id. */
  async addTrack(fixture: WavFixture): Promise<string> {
    const readIds = () =>
      this.host.page.evaluate(() =>
        ((window as any).__MUSIXQUARE_GET_STATE__('playlist.items') ?? []).map(
          (item: any) => item.queueItemId as string,
        ),
      );
    const before = await readIds();
    await this.host.page.locator('#file-input').setInputFiles(fixture.path);
    await this.host.page.waitForFunction(
      (known) =>
        ((window as any).__MUSIXQUARE_GET_STATE__('playlist.items') ?? []).some(
          (item: any) => !known.includes(item.queueItemId),
        ),
      before,
      { timeout: 20_000 },
    );
    const after = await readIds();
    return after.find((id: string) => !before.includes(id))!;
  }

  /** Bytes of one track's chunks the guest has received on a lane since a time. */
  guestChunkBytes(type: 'file-chunk' | 'preload-chunk', queueItemId: string, since: number) {
    return this.guest.page.evaluate(
      ({ type, queueItemId, since }) => {
        let bytes = 0;
        for (const row of (window as any).__labProbe.frames) {
          if (
            row.at >= since &&
            row.dir === 'recv' &&
            row.type === type &&
            row.queueItemId === queueItemId
          ) {
            bytes += row.payloadBytes;
          }
        }
        return bytes;
      },
      { type, queueItemId, since },
    );
  }

  /** The guest's resident Blob of a lane, hashed in the page. */
  guestBlob(
    lane: 'current' | 'preload',
  ): Promise<{ queueItemId: string | null; bytes: number; sha256: string } | null> {
    return this.guest.page.evaluate(async (lane) => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      const holder = lane === 'current' ? get('files.current') : get('preload.ready');
      if (!(holder?.blob instanceof Blob)) return null;
      const bytes = await holder.blob.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return {
        queueItemId: holder.queueItemId ?? null,
        bytes: bytes.byteLength,
        sha256: [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join(''),
      };
    }, lane);
  }

  /** Both pages' probe records so far. */
  async probes(): Promise<{ host: ProbeExport; guest: ProbeExport }> {
    return { host: await readProbe(this.host.page), guest: await readProbe(this.guest.page) };
  }

  /** Everything both pages saw, kept under test-results/lab/ whatever the reporter. */
  private async attachEvidence(testInfo: TestInfo): Promise<void> {
    const { host, guest } = await this.probes();
    const body = JSON.stringify(
      {
        marks: this.marks,
        notes: this.notes,
        shaping: this.shaping.history,
        host: { probe: host, console: this.host.console, pageErrors: this.host.pageErrors },
        guest: { probe: guest, console: this.guest.console, pageErrors: this.guest.pageErrors },
      },
      null,
      1,
    );
    const path = testInfo.outputPath('lab-evidence.json');
    await writeFile(path, body);
    await testInfo.attach('lab-evidence.json', { path, contentType: 'application/json' });
  }

  async close(testInfo: TestInfo): Promise<void> {
    // An outage must never outlive the scenario.
    if (this.shaping.history.at(-1)?.interrupted) await this.restore().catch(() => {});
    await this.attachEvidence(testInfo).catch(() => {});
    await this.host.context.close().catch(() => {});
    await this.guest.context.close().catch(() => {});
  }
}
