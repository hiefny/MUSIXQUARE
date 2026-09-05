import { describe, expect, it } from 'vitest';

import {
  assertDurableObjectMigrationContract,
  assertDurableObjectMigrationManifestAppendOnly,
  assertDurableObjectMigrationRepositoryHistory,
  loadDurableObjectMigrationManifest,
  parseProductionWranglerMigrations,
} from '../../../scripts/check-durable-object-migration-contract.mts';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('Durable Object migration contract', () => {
  it('matches every production Wrangler migration exactly', () => {
    expect(assertDurableObjectMigrationContract()).toEqual({
      schemaVersion: 1,
      configCount: 6,
      migrationCount: 7,
    });
  });

  it('parses only the top-level Worker identity and ordered migration entries', () => {
    expect(
      parseProductionWranglerMigrations(`
        name = "worker-name"
        [[durable_objects.bindings]]
        name = "NOT_THE_SCRIPT_NAME"
        class_name = "FirstClass"
        [[migrations]]
        tag = "v1"
        new_sqlite_classes = [
          "FirstClass",
        ]
        [[migrations]]
        tag = "v2"
        deleted_classes = ["FirstClass"]
      `),
    ).toEqual({
      scriptName: 'worker-name',
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['FirstClass'] },
        { tag: 'v2', deleted_classes: ['FirstClass'] },
      ],
    });
  });

  it('fails closed when the manifest omits a production config or rewrites TOML history', () => {
    const missing = clone(loadDurableObjectMigrationManifest());
    missing.configs = missing.configs.filter(
      (entry: { config: string }) => entry.config !== 'cloudflare/wrangler.app.toml',
    );
    expect(() => assertDurableObjectMigrationContract({ manifest: missing })).toThrow(
      'unregistered: cloudflare/wrangler.app.toml',
    );

    const rewritten = clone(loadDurableObjectMigrationManifest());
    const remote = rewritten.configs.find(
      (entry: { config: string }) => entry.config === 'cloudflare/wrangler.remote-share.toml',
    );
    if (!remote) throw new Error('Expected the remote-share manifest entry');
    remote.migrations[0].new_sqlite_classes = ['RewrittenClass'];
    expect(() => assertDurableObjectMigrationContract({ manifest: rewritten })).toThrow(
      'do not exactly match',
    );
  });

  it('includes whitespace migration tables so an appended deletion cannot evade the manifest', () => {
    const parsed = parseProductionWranglerMigrations(`
      name = "worker-name"
      [[migrations]]
      tag = "v1"
      new_sqlite_classes = ["Room"]
      [[ migrations ]]
      tag = "v2"
      deleted_classes = ["Room"]
    `);
    expect(parsed.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['Room'] },
      { tag: 'v2', deleted_classes: ['Room'] },
    ]);
  });

  it.each([
    '[ [ "migrations" ] ]',
    '[["migrations"]]',
    "[['migrations']]",
    '[["\\u006digrations"]]',
    '[ "exports" . Room ]',
    "['exports'.Room]",
    '[[ migrations . nested ]]',
    '[migrations]',
  ])('fails closed instead of ignoring unsupported table %s', (table) => {
    expect(() =>
      parseProductionWranglerMigrations(
        `name = "worker-name"\n${table}\ntag = "v2"\ndeleted_classes = ["Room"]`,
      ),
    ).toThrow('unsupported');
  });

  it.each([
    'migrations = [{ tag = "v2", deleted_classes = ["Room"] }]',
    'exports.Room = { type = "durable-object", storage = "sqlite" }',
    '"migrations" = [{ tag = "v2", deleted_classes = ["Room"] }]',
  ])('fails closed on an unsupported top-level declaration: %s', (statement) => {
    expect(() => parseProductionWranglerMigrations(`name = "worker-name"\n${statement}`)).toThrow(
      'unsupported top-level',
    );
  });

  it('preserves the declarative export rejection after whitespace normalization', () => {
    expect(() =>
      parseProductionWranglerMigrations(
        'name = "worker-name"\n[ exports . Room ]\ntype = "durable-object"',
      ),
    ).toThrow('extend the canonical Durable Object contract');
  });

  it('allows only suffix appends to every existing per-script history', () => {
    const current = clone(loadDurableObjectMigrationManifest());
    const previous = clone(current);
    const previousRemote = previous.configs.find(
      (entry: { config: string }) => entry.config === 'cloudflare/wrangler.remote-share.toml',
    );
    if (!previousRemote) throw new Error('Expected the remote-share manifest entry');
    previousRemote.migrations = previousRemote.migrations.slice(0, -1);
    expect(
      assertDurableObjectMigrationManifestAppendOnly({
        previousManifest: previous,
        currentManifest: current,
      }),
    ).toEqual({ previousConfigCount: 6 });

    const rewritten = clone(current);
    const rewrittenRemote = rewritten.configs.find(
      (entry: { config: string }) => entry.config === 'cloudflare/wrangler.remote-share.toml',
    );
    if (!rewrittenRemote) throw new Error('Expected the remote-share manifest entry');
    rewrittenRemote.migrations[0].tag = 'rewritten-v1';
    expect(() =>
      assertDurableObjectMigrationManifestAppendOnly({
        previousManifest: current,
        currentManifest: rewritten,
      }),
    ).toThrow('migration history is append-only');
  });

  it('walks every first-parent manifest revision and rejects rewritten history', () => {
    const current = clone(loadDurableObjectMigrationManifest());
    const first = clone(current);
    const firstPro = first.configs.find(
      (entry: { config: string }) => entry.config === 'cloudflare/wrangler.pro-room.toml',
    );
    if (!firstPro) throw new Error('Expected the PRO manifest entry');
    firstPro.migrations = firstPro.migrations.slice(0, -1);
    const firstCommit = '1'.repeat(40);
    const secondCommit = '2'.repeat(40);
    const runner = (_command: string, args: string[]) => {
      if (args[0] === 'log') return `${firstCommit}\n${secondCommit}\n`;
      if (args[0] === 'show' && args[1].startsWith(firstCommit)) return JSON.stringify(first);
      if (args[0] === 'show' && args[1].startsWith(secondCommit)) return JSON.stringify(current);
      throw new Error(`Unexpected git operation: ${args.join(' ')}`);
    };
    expect(
      assertDurableObjectMigrationRepositoryHistory({ currentManifest: current, runner }),
    ).toEqual({ visibleRevisionCount: 2 });

    const rewritten = clone(current);
    rewritten.configs[2].migrations[0].tag = 'changed';
    const rewrittenRunner = (_command: string, args: string[]) => {
      if (args[0] === 'log') return `${firstCommit}\n${secondCommit}\n`;
      if (args[0] === 'show' && args[1].startsWith(firstCommit)) return JSON.stringify(current);
      if (args[0] === 'show' && args[1].startsWith(secondCommit)) {
        return JSON.stringify(rewritten);
      }
      throw new Error(`Unexpected git operation: ${args.join(' ')}`);
    };
    expect(() =>
      assertDurableObjectMigrationRepositoryHistory({
        currentManifest: rewritten,
        runner: rewrittenRunner,
      }),
    ).toThrow('migration history is append-only');
  });

  it('rejects unsupported legacy migration shapes until the guard understands them', () => {
    expect(() =>
      parseProductionWranglerMigrations(`
        name = "worker-name"
        [[migrations]]
        tag = "v2"
        renamed_classes = [{ from = "OldClass", to = "NewClass" }]
      `),
    ).toThrow('extend the guard before using another migration shape');

    expect(() =>
      parseProductionWranglerMigrations(`
        name = "worker-name"
        [exports.NewClass]
        type = "durable-object"
        storage = "sqlite"
      `),
    ).toThrow('extend the canonical Durable Object contract');
  });
});
