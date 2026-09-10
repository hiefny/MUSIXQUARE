import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';

interface SourceFile {
  file: string;
  bytes: number;
  sha256: string;
  kind: string;
}
interface Variant {
  id: string;
  source: string;
  language: 'en' | 'ko';
  label: string;
  width: number;
  height: number;
  filename: string;
  bytes: number;
  sha256: string;
  sourceFiles: SourceFile[];
}
interface Manifest {
  fps: number;
  durationSeconds: number;
  frames: number;
  whiteFromFrame: number;
  variants: Variant[];
}
interface Stream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
}
declare global {
  interface Window {
    ready?: Promise<unknown>;
    draw?: (time: number) => void;
  }
}
const root = path.dirname(fileURLToPath(import.meta.url)),
  execute = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const cancellation = new AbortController();
process.once('SIGINT', () => cancellation.abort(new Error('Interrupted')));
process.once('SIGTERM', () => cancellation.abort(new Error('Terminated')));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
};

function confined(base: string, relative: string): string {
  const result = path.resolve(base, relative),
    delta = path.relative(base, result);
  if (
    path.isAbsolute(relative) ||
    delta === '..' ||
    delta.startsWith(`..${path.sep}`) ||
    path.isAbsolute(delta)
  )
    throw new Error(`Path leaves its directory: ${relative}`);
  return result;
}
function leaf(value: string): string {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    path.posix.basename(value) !== value ||
    path.win32.basename(value) !== value
  )
    throw new Error(`Invalid manifest name: ${value}`);
  return value;
}
async function localFile(base: string, relative: string): Promise<string> {
  const file = await realpath(confined(base, relative));
  confined(base, path.relative(base, file));
  return file;
}
async function sourceRoot(variant: Variant): Promise<string> {
  const base = await realpath(path.join(root, 'source'));
  return localFile(base, leaf(variant.source));
}
async function assertHash(base: string, file: SourceFile): Promise<void> {
  cancellation.signal.throwIfAborted();
  const bytes = await readFile(await localFile(base, file.file));
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
    throw new Error(`Integrity mismatch: ${file.file}`);
}
async function verify(variant: Variant, manifest: Manifest): Promise<void> {
  const source = await sourceRoot(variant),
    output = await realpath(path.join(root, 'output'));
  for (const file of variant.sourceFiles) await assertHash(source, file);
  await assertHash(output, {
    file: leaf(variant.filename),
    bytes: variant.bytes,
    sha256: variant.sha256,
    kind: 'master',
  });
  const movie = await localFile(output, variant.filename);
  const { stdout } = await execute(
    ffprobe,
    ['-v', 'error', '-show_streams', '-of', 'json', movie],
    { encoding: 'utf8', windowsHide: true, signal: cancellation.signal },
  );
  const probe = JSON.parse(stdout) as { streams: Stream[] };
  const video = probe.streams.find((s) => s.codec_type === 'video'),
    audio = probe.streams.find((s) => s.codec_type === 'audio');
  if (
    !video ||
    video.codec_name !== 'h264' ||
    video.width !== variant.width ||
    video.height !== variant.height ||
    video.r_frame_rate !== `${manifest.fps}/1` ||
    Number(video.nb_frames) !== manifest.frames ||
    Number(video.duration) !== manifest.durationSeconds
  )
    throw new Error(`Video specification mismatch: ${variant.id}`);
  if (!audio || audio.codec_name !== 'aac' || audio.sample_rate !== '48000' || audio.channels !== 2)
    throw new Error(`Audio specification mismatch: ${variant.id}`);
  console.log(
    `Verified ${variant.id}: master SHA-256, ${variant.sourceFiles.length} source files, ${variant.width}×${variant.height}, ${manifest.fps} fps, ${manifest.durationSeconds}s, stereo AAC 48 kHz.`,
  );
}

async function withFilm(
  variant: Variant,
  action: (page: Page, source: string, errors: Error[]) => Promise<void>,
): Promise<void> {
  const source = await sourceRoot(variant),
    errors: Error[] = [];
  const server = http.createServer((request, response) => {
    const serve = async () => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end();
        return;
      }
      const relative =
        decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname).slice(1) ||
        'film.html';
      const file = await localFile(source, relative),
        bytes = await readFile(file);
      response.writeHead(200, {
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    };
    serve().catch(() => {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    });
  });
  let browser: Browser | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    browser = await chromium.launch({
      channel: process.env.BROWSER_CHANNEL || 'chrome',
      headless: true,
    });
    const page = await browser.newPage({
      viewport: { width: variant.width, height: variant.height },
      deviceScaleFactor: 1,
    });
    page.on('pageerror', (error) => errors.push(error));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Preview server did not start');
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.evaluate(async () => {
      const film = window;
      if (typeof film.draw !== 'function' || typeof film.ready?.then !== 'function')
        throw new Error('Source does not expose window.ready and window.draw');
      await film.ready;
    });
    const size = await page.locator('#film').evaluate((element) => {
      if (!(element instanceof HTMLCanvasElement)) throw new Error('Missing film canvas');
      return { width: element.width, height: element.height };
    });
    if (size.width !== variant.width || size.height !== variant.height)
      throw new Error('Film canvas dimensions differ from manifest');
    if (errors.length) throw new AggregateError(errors, 'Source page failed');
    await action(page, source, errors);
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  } finally {
    const cleanup = await Promise.allSettled([
      browser?.close(),
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
    ]);
    for (const result of cleanup)
      if (result.status === 'rejected')
        errors.push(new Error(`Cleanup failed: ${String(result.reason)}`));
  }
  if (errors.length)
    throw new AggregateError(errors, errors.map((error) => error.message).join('\n'));
}
async function preview(variant: Variant): Promise<void> {
  const output = confined(path.join(root, 'output', 'previews'), leaf(variant.id));
  await mkdir(output, { recursive: true });
  await withFilm(variant, async (page) => {
    for (const time of [0.8, 4.5, 9.5, 12.3, 18.3, 25.7, 29.8, 32.6]) {
      cancellation.signal.throwIfAborted();
      await page.evaluate((time) => {
        if (typeof window.draw !== 'function') throw new Error('Missing film draw function');
        window.draw(time);
      }, time);
      await page.screenshot({ path: path.join(output, `${time.toFixed(3)}.png`), type: 'png' });
    }
  });
  console.log(`Preview ${variant.id}: ${output}`);
}

async function render(variant: Variant, manifest: Manifest): Promise<void> {
  const directory = path.join(root, 'output', 'renders');
  await mkdir(directory, { recursive: true });
  const output = confined(directory, leaf(variant.filename)),
    temporary = `${output}.${process.pid}.partial.mp4`;
  try {
    await withFilm(variant, async (page, source, errors) => {
      const vf = `scale=iw:ih:in_color_matrix=bt601:out_color_matrix=bt709:in_range=pc:out_range=tv,setsar=1,format=yuv420p,lutyuv=y=235:u=128:v=128:enable=eq(n\\,0)+gte(n\\,${manifest.whiteFromFrame}),setparams=range=limited:colorspace=bt709:color_primaries=bt709:color_trc=bt709`;
      const args = '-y -hide_banner -loglevel warning -f image2pipe -vcodec mjpeg -framerate'.split(
        ' ',
      );
      args.push(
        String(manifest.fps),
        '-i',
        'pipe:0',
        '-i',
        await localFile(source, 'assets/score-arena.wav'),
      );
      args.push(...'-map 0:v:0 -map 1:a:0 -c:v libx264 -preset medium -crf 17 -vf'.split(' '), vf);
      args.push(
        ...'-pix_fmt yuv420p -force_key_frames'.split(' '),
        `expr:eq(n,${manifest.whiteFromFrame})`,
        '-forced-idr',
        '1',
        '-r',
        String(manifest.fps),
      );
      args.push(
        ...'-color_primaries bt709 -color_trc bt709 -colorspace bt709 -c:a aac -b:a 256k -ar 48000 -t'.split(
          ' ',
        ),
        String(manifest.durationSeconds),
        '-movflags',
        '+faststart',
      );
      args.push(
        '-metadata',
        `title=MUSIXQUARE | ${variant.language === 'ko' ? 'Korean' : 'English'} | Semibold captions`,
        temporary,
      );
      const encoder = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      let failure: Error | undefined,
        diagnostics = '';
      encoder.stderr.on('data', (data: Buffer) => {
        diagnostics = (diagnostics + data.toString()).slice(-8000);
      });
      encoder.stdin.on('error', (error) => {
        failure = error;
      });
      const closed = new Promise<void>((resolve) => {
        encoder.once('error', (error) => {
          failure = error;
          resolve();
        });
        encoder.once('close', (code, signal) => {
          if (code !== 0) failure ??= new Error(`FFmpeg exited ${code ?? signal}: ${diagnostics}`);
          resolve();
        });
      });
      try {
        for (let frame = 0; frame < manifest.frames; frame++) {
          cancellation.signal.throwIfAborted();
          if (failure) throw failure;
          if (errors.length)
            throw new AggregateError(errors, 'Source page failed during rendering');
          const jpeg = await page.evaluate((time) => {
            if (typeof window.draw !== 'function') throw new Error('Missing film draw function');
            window.draw(time);
            const canvas = document.getElementById('film');
            if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing film canvas');
            return canvas.toDataURL('image/jpeg', 0.98).split(',')[1];
          }, frame / manifest.fps);
          if (!jpeg) throw new Error('Empty JPEG frame');
          // Waiting for each write callback bounds buffering and handles pipe backpressure.
          await Promise.race([
            new Promise<void>((resolve, reject) => {
              encoder.stdin.write(Buffer.from(jpeg, 'base64'), (error) =>
                error ? reject(error) : resolve(),
              );
            }),
            closed.then(() => {
              throw failure ?? new Error('FFmpeg closed before the final frame');
            }),
          ]);
          if (frame % 360 === 0)
            console.log(`${variant.id}: ${Math.round((frame / manifest.frames) * 100)}%`);
        }
        encoder.stdin.end();
        await closed;
        if (failure) throw failure;
      } finally {
        if (encoder.exitCode === null && !encoder.signalCode) encoder.kill();
        await closed;
      }
    });
    await rename(temporary, output);
    console.log(`Rendered ${variant.id}: ${output} (approved master preserved)`);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as Manifest;
  if (
    manifest.fps !== 60 ||
    manifest.frames !== 2115 ||
    manifest.durationSeconds !== 35.25 ||
    manifest.whiteFromFrame !== 2106
  )
    throw new Error('Unsupported final-ad timing manifest');
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(
      'MUSIXQUARE approved final ads\n\n  npm run promo:render -- --verify [--variant id|all]\n  npm run promo:render -- --preview [--variant id|all]\n  npm run promo:render -- --variant id|all\n\nVerify/preview default to all variants; renders go to output/renders, preserving masters.\nFFMPEG_PATH, FFPROBE_PATH and BROWSER_CHANNEL override tools (Chrome is default).\n',
    );
    for (const variant of manifest.variants)
      console.log(
        `  ${variant.id}: ${variant.label} · ${variant.width}×${variant.height} · ${variant.filename}`,
      );
    return;
  }
  let mode: 'render' | 'verify' | 'preview' = 'render',
    selected = 'all';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--variant') {
      selected = args[++i] || '';
      if (!selected || selected.startsWith('--'))
        throw new Error('--variant requires an id or all');
    } else if (arg === '--verify' || arg === '--preview') {
      if (mode !== 'render') throw new Error('Choose only one of --verify and --preview');
      mode = arg === '--verify' ? 'verify' : 'preview';
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const variants = manifest.variants.filter(
    (variant) => selected === 'all' || variant.id === selected,
  );
  if (!variants.length) throw new Error(`Unknown variant: ${selected}`);
  for (const variant of variants) {
    cancellation.signal.throwIfAborted();
    if (mode === 'verify') await verify(variant, manifest);
    else if (mode === 'preview') await preview(variant);
    else await render(variant, manifest);
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
