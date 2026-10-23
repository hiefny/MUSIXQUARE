import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Loader } from 'esbuild';
import type { AppWorkerEntry, CronEntry } from './owner-transfer-saga-fixture.ts';

/**
 * An earlier App Worker build for mixed-version tests. During a Worker deploy
 * a request still running on the old version can meet the minute cron on the
 * new one, and the reverse, on the same D1 rows. This loads
 * `cloudflare/app-worker.ts` and every repository module it imports exactly
 * as committed at `sha` (read with `git show`, so later edits to a sibling do
 * not leak in), bundles them with esbuild, and imports the bundle as a
 * separate module instance next to the current one. npm packages resolve from
 * today's `node_modules`.
 *
 * It needs the commit in the local history: CI checks out with
 * `fetch-depth: 0`, and `hasCommit` lets a shallow clone skip instead of
 * failing.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CLOUDFLARE_DIR = fileURLToPath(new URL('../../../../cloudflare/', import.meta.url));

const LOADERS: Record<string, Loader> = {
  ts: 'ts',
  mts: 'ts',
  js: 'js',
  mjs: 'js',
  json: 'json',
};

function git(args: string[]) {
  return execFileSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Whether `sha` is a commit in this checkout's history. */
export function hasCommit(sha: string) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export interface LegacyAppWorker {
  /** The legacy default export: its `fetch` serves requests as the old version did. */
  readonly worker: AppWorkerEntry;
  /** The legacy minute-cron saga sweep. */
  readonly cron: CronEntry;
}

const builds = new Map<string, Promise<LegacyAppWorker>>();

/** The App Worker as committed at `sha`, built once per test file. */
export function loadLegacyAppWorker(sha: string): Promise<LegacyAppWorker> {
  let loaded = builds.get(sha);
  if (!loaded) {
    loaded = buildLegacyAppWorker(sha);
    builds.set(sha, loaded);
  }
  return loaded;
}

async function buildLegacyAppWorker(sha: string): Promise<LegacyAppWorker> {
  const result = await build({
    stdin: {
      contents: git(['show', `${sha}:cloudflare/app-worker.ts`]),
      resolveDir: CLOUDFLARE_DIR,
      sourcefile: `app-worker@${sha.slice(0, 8)}.ts`,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    write: false,
    plugins: [
      {
        name: 'legacy-repository-sources',
        setup(pluginBuild) {
          pluginBuild.onLoad({ filter: /\.(?:[mc]?[jt]s|json)$/ }, (args) => {
            const path = relative(REPOSITORY_ROOT, args.path).replaceAll('\\', '/');
            if (path.startsWith('..') || path.split('/').includes('node_modules')) return undefined;
            const extension = path.slice(path.lastIndexOf('.') + 1);
            return {
              contents: git(['show', `${sha}:${path}`]),
              loader: LOADERS[extension] ?? 'ts',
            };
          });
        },
      },
    ],
  });
  const source = result.outputFiles[0]?.text;
  if (!source) throw new Error(`Missing legacy App Worker build for ${sha}`);
  const module = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )) as { default: AppWorkerEntry; reconcileOwnerTransferSagasForTests: CronEntry };
  return { worker: module.default, cron: module.reconcileOwnerTransferSagasForTests };
}
