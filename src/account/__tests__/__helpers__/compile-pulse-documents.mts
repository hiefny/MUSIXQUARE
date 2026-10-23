/**
 * Compiles the account pulse copies for account-pulse-documents.ts in a plain
 * Node process: esbuild refuses to load inside Vitest's jsdom environment,
 * whose global Uint8Array belongs to the jsdom realm.
 *
 * Usage (cwd = repository root): node compile-pulse-documents.mts < request.json
 * Writes the compiled script to stdout. The request (stdin, JSON) is one of:
 * - { "kind": "classic", "outputPath": "events/event.js" }: a classic runtime,
 *   compiled exactly as the build compiles it (scripts/classic-runtime-assets.ts).
 * - { "kind": "session", "globalName": "...", "sources"?: { "<repo path>": "<text>" } }:
 *   an IIFE of the real src/account/session.ts and state.ts. `sources`
 *   replaces whole files of the module graph, for a drift self-test or a
 *   frozen older copy (a mixed-version tab).
 */
import { relative } from 'node:path';
import { build, type Plugin } from 'esbuild';
import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../../scripts/classic-runtime-assets.ts';

type CompileRequest =
  | { readonly kind: 'classic'; readonly outputPath: string }
  | {
      readonly kind: 'session';
      readonly globalName: string;
      readonly sources?: Readonly<Record<string, string>>;
    };

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CompileRequest;
const root = process.cwd();

function sourceOverrides(sources: Readonly<Record<string, string>>): Plugin {
  const pending = new Set(Object.keys(sources));
  return {
    name: 'account-pulse-source-overrides',
    setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, (args) => {
        const path = relative(root, args.path).split('\\').join('/');
        if (!(path in sources)) return undefined;
        pending.delete(path);
        return { contents: sources[path], loader: 'ts' };
      });
      builder.onEnd(() => {
        if (pending.size > 0)
          throw new Error(`not in the module graph: ${[...pending].join(', ')}`);
      });
    },
  };
}

async function compile(): Promise<string> {
  if (request.kind === 'classic') {
    const asset = CLASSIC_RUNTIME_ASSETS.find(
      (candidate) => candidate.outputPath === request.outputPath,
    );
    if (!asset) throw new Error(`${request.outputPath} is not a classic runtime asset`);
    return (await compileClassicRuntimeAsset(root, asset)).code;
  }
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents:
        "export * as session from './src/account/session.ts';\n" +
        "export * as state from './src/account/state.ts';\n",
      resolveDir: root,
      sourcefile: 'account-pulse-app-document.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: request.globalName,
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    // Mirror the shipped build: production log level, no dev-only branches.
    define: { 'import.meta.env': '{"PROD":true,"DEV":false}' },
    plugins: request.sources ? [sourceOverrides(request.sources)] : [],
  });
  return result.outputFiles[0]!.text;
}

process.stdout.write(await compile());
