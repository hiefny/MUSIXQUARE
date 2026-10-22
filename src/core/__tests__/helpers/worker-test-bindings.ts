import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * Platform fakes for in-process Cloudflare Worker characterization tests.
 *
 * SqliteD1 runs the tracked D1 schema files in node:sqlite and executes the
 * production SQL text unchanged. It models: positional `?N` binding, `first`,
 * `all`, `run` with `meta.changes`, and an atomic `batch` (all statements or
 * none). It does not model D1 latency, row/size limits, read replicas, or the
 * network failures of a real binding; tests inject those through `hooks`,
 * which run before a statement executes and may throw (an outage) or await (a
 * slow call that lets another request interleave). Every executed write is
 * appended to `writes`, in order, across all databases that share a journal.
 *
 * MemoryDurableObjectStorage models the Durable Object key-value storage API
 * the PRO room uses (structured-clone get/put/delete, transaction rollback and
 * a single alarm slot). It does not model SQL storage, output gates or
 * input-gate concurrency; the PRO room serializes its own mutations.
 */

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqlEvent {
  readonly db: string;
  readonly sql: string;
  readonly values: readonly SqlValue[];
}

export type SqlHook = (event: SqlEvent) => void | Promise<void>;

export interface SqlJournal {
  readonly hooks: SqlHook[];
  readonly writes: SqlEvent[];
}

export const nodeSqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    // Keep collection readable on an unsupported runtime; suites skip instead.
    return null;
  }
})();

export function trackedSql(fileName: string): string {
  return readFileSync(new URL(`../../../../cloudflare/${fileName}`, import.meta.url), 'utf8');
}

export function createSqlJournal(): SqlJournal {
  return { hooks: [], writes: [] };
}

class SqliteD1Statement {
  constructor(
    private readonly owner: SqliteD1,
    private readonly sql: string,
    private readonly statement: StatementSync,
    private readonly values: readonly SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    // D1 stores booleans as integers; node:sqlite rejects them.
    const bound = values.map((value) =>
      typeof value === 'boolean' ? Number(value) : (value as SqlValue),
    );
    return new SqliteD1Statement(this.owner, this.sql, this.statement, bound);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    await this.owner.before(this.sql, this.values);
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    await this.owner.before(this.sql, this.values);
    return { results: this.statement.all(...this.values) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    await this.owner.before(this.sql, this.values);
    return this.execute();
  }

  async beforeBatch(): Promise<void> {
    await this.owner.before(this.sql, this.values);
  }

  execute(): { success: true; meta: { changes: number } } {
    const result = this.statement.run(...this.values);
    this.owner.record(this.sql, this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

export class SqliteD1 {
  readonly database: DatabaseSync;

  constructor(
    readonly name: string,
    schemaSql: string,
    private readonly journal: SqlJournal = createSqlJournal(),
  ) {
    if (!nodeSqlite) throw new Error('node:sqlite is unavailable');
    this.database = new nodeSqlite.DatabaseSync(':memory:');
    this.database.exec(schemaSql);
  }

  async before(sql: string, values: readonly SqlValue[]): Promise<void> {
    for (const hook of [...this.journal.hooks]) await hook({ db: this.name, sql, values });
  }

  record(sql: string, values: readonly SqlValue[]): void {
    if (/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) {
      this.journal.writes.push({ db: this.name, sql, values: [...values] });
    }
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this, sql, this.database.prepare(sql));
  }

  async batch(statements: SqliteD1Statement[]) {
    // Hooks may await or throw before the batch starts; the batch itself is
    // atomic, as in D1, so no other statement can interleave inside it.
    for (const statement of statements) await statement.beforeBatch();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  rows<T = Record<string, unknown>>(sql: string, ...values: SqlValue[]): T[] {
    return this.database.prepare(sql).all(...values) as T[];
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

export class MemoryDurableObjectStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;

  async get(key: string | string[]): Promise<unknown> {
    if (Array.isArray(key)) {
      return new Map(key.map((entry) => [entry, structuredClone(this.data.get(entry))]));
    }
    return structuredClone(this.data.get(key));
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === 'string') {
      this.data.set(key, structuredClone(value));
      return;
    }
    for (const [entry, content] of Object.entries(key)) {
      this.data.set(entry, structuredClone(content));
    }
  }

  async delete(key: string | string[]): Promise<number | boolean> {
    if (Array.isArray(key)) {
      return key.reduce((count, entry) => count + Number(this.data.delete(entry)), 0);
    }
    return this.data.delete(key);
  }

  async transaction<T>(operation: (storage: MemoryDurableObjectStorage) => Promise<T>): Promise<T> {
    const before = structuredClone([...this.data]);
    try {
      return await operation(this);
    } catch (error) {
      this.data.clear();
      for (const [key, value] of before) this.data.set(key, value);
      throw error;
    }
  }

  async setAlarm(value: number): Promise<void> {
    this.alarm = value;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}
