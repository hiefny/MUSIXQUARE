import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  analyzeLegacyBoundedV1Safety,
  type LegacyBoundedV1SafetyAnalysis,
} from '../../../scripts/lib/legacy-bounded-v1-safety-analyzer.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PROTECTED_FILE = 'src/player/legacy-bounded-file-v1-product.ts';
const temporaryRoots = new Set<string>();

function writeFixture(root: string, file: string, source: string): void {
  const absolute = join(root, ...file.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, 'utf8');
}

function analyzeFixture(source: string): LegacyBoundedV1SafetyAnalysis {
  const root = mkdtempSync(join(tmpdir(), 'musixquare-bounded-v1-safety-'));
  temporaryRoots.add(root);
  writeFixture(
    root,
    'tsconfig.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          allowImportingTsExtensions: true,
          module: 'ESNext',
          moduleResolution: 'bundler',
          noEmit: true,
          strict: true,
          target: 'ES2022',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  writeFixture(
    root,
    'src/network/transport/types.ts',
    `export interface TransportDataConnection {
  peer: string;
  open: boolean;
  send(data: unknown): void;
  close(): void;
}
`,
  );
  writeFixture(
    root,
    'src/types/index.ts',
    `import type { TransportDataConnection } from '../network/transport/types.ts';
export type DataConnection = TransportDataConnection;
`,
  );
  writeFixture(
    root,
    'src/network/file-playback-application-session.ts',
    'export const oldApplicationSession = true;\n',
  );
  writeFixture(
    root,
    'src/player/file-playback-product-runtime.ts',
    'export const oldProductRuntime = true;\n',
  );
  writeFixture(root, PROTECTED_FILE, source);
  return analyzeLegacyBoundedV1Safety({
    root,
    protectedFiles: [PROTECTED_FILE],
  });
}

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
  temporaryRoots.clear();
});

describe('legacy bounded-file V1 production safety guard', () => {
  it('keeps the checked-in production boundary clean', () => {
    const result = spawnSync(process.execPath, ['scripts/check-legacy-bounded-v1-safety.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      'OK - protected bounded-V1 modules contain no direct DataConnection lifecycle authority or old V2 runtime import.',
    );
  });

  it.each([
    [
      'application-session import',
      "import '../network/file-playback-application-session.ts';\n",
      'file-playback-application-session.ts',
    ],
    [
      'product-runtime re-export',
      "export * from './file-playback-product-runtime.ts';\n",
      'file-playback-product-runtime.ts',
    ],
    [
      'literal dynamic import',
      "void import('../network/file-playback-application-session.ts');\n",
      'file-playback-application-session.ts',
    ],
  ])('rejects an old V2 %s', (_label, source, target) => {
    const result = analyzeFixture(source);

    expect(result.violations).toContainEqual(
      expect.stringContaining(`forbidden old V2 module import`),
    );
    expect(result.violations).toContainEqual(expect.stringContaining(target));
  });

  it('fails closed for a computed dynamic import', () => {
    const result = analyzeFixture(
      "const modulePath = './file-playback-product-runtime.ts';\nvoid import(modulePath);\n",
    );

    expect(result.violations).toContainEqual(
      expect.stringContaining('computed dynamic import is forbidden'),
    );
  });

  it.each([
    ['direct close', 'connection.close();', 'DataConnection.close'],
    ['optional terminate', 'connection?.terminate();', 'DataConnection.terminate'],
    ['element close', "connection['close']();", 'DataConnection.close'],
    ['destructured close', 'const { close } = connection;\nclose();', 'DataConnection.close'],
  ])('rejects %s on a typed connection', (_label, operation, finding) => {
    const result = analyzeFixture(
      `import type { DataConnection as Connection } from '../types/index.ts';
export function violate(connection: Connection): void {
  ${operation}
}
`,
    );

    expect(result.violations).toContainEqual(expect.stringContaining(finding));
  });

  it('rejects erasing a connection type before accessing lifecycle authority', () => {
    const result = analyzeFixture(
      `import type { DataConnection } from '../types/index.ts';
export function violate(connection: DataConnection): void {
  const escaped = connection as unknown as { terminate(): void };
  escaped.terminate();
}
`,
    );

    expect(result.violations).toContainEqual(
      expect.stringContaining("erasing DataConnection's static type is forbidden"),
    );
  });

  it('allows close methods on non-connection resources', () => {
    const result = analyzeFixture(
      `interface EncodedSource {
  close(): Promise<void>;
}
export async function cleanUp(source: EncodedSource): Promise<void> {
  await source.close();
}
`,
    );

    expect(result.violations).toEqual([]);
  });
});
