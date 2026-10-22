import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureAdminProRoomRegistryForTests,
  ownerTransferSagaStatesForTests,
  reconcileOwnerTransferSagasForTests,
} from '../../../cloudflare/app-worker.ts';
import { nodeSqlite, SqliteD1, trackedSql } from './helpers/worker-test-bindings.ts';

/**
 * Drift guard for the owner-transfer saga states (resource RO-09 in
 * docs/design/resource-ownership-registry.md, plan step C7-2b).
 *
 * The App Worker names the states once (OWNER_TRANSFER_SAGA_STATES and its
 * nonterminal, terminal and ranked subsets) and builds its SQL state lists
 * from them. Three SQL copies of the full list stay as written, because D1
 * migrations and the runtime DDL own them: the migration that added the
 * table, the fresh-install schema, and ensureAdminProRoomRegistry. This file
 * keeps all three equal to the TypeScript list, and runs the generated cron
 * listing, rotation and decommission terminalization SQL in node:sqlite.
 */

const SAGA_TABLE = 'mxqr_pro_room_owner_transfer_sagas';
const TARGET = `acct_${'T'.repeat(22)}`;
const PREVIOUS_OWNER = `acct_${'P'.repeat(22)}`;
const FENCE_DIGEST = 'F'.repeat(43);
const NOW = 50_000;
const databases: SqliteD1[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function adminDatabase(schemaSql: string) {
  const database = new SqliteD1('admin', schemaSql);
  databases.push(database);
  return database;
}

/** The quoted names in the saga table's `state ... CHECK (state IN (...))`. */
function sagaStateCheck(sql: string): string[] {
  const table = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${SAGA_TABLE}\\s*\\(`).exec(sql);
  if (!table) throw new Error(`no CREATE TABLE ${SAGA_TABLE}`);
  const rest = sql.slice(table.index + table[0].length);
  const nextTable = rest.search(/CREATE TABLE/);
  const body = nextTable === -1 ? rest : rest.slice(0, nextTable);
  const check = /\bstate TEXT NOT NULL CHECK \(state IN \(([^)]*)\)\)/.exec(body);
  if (!check) throw new Error(`no state CHECK in ${SAGA_TABLE}`);
  return [...(check[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1] ?? '');
}

function roomCode(index: number) {
  return String(100 + index).padStart(6, '0');
}

/** One saga row per state, each in its own synthetic room at generation 0. */
function insertOneSagaPerState(database: SqliteD1, states: readonly string[]) {
  const insert = database.database.prepare(
    `INSERT INTO ${SAGA_TABLE} (
       room_code, room_generation, claim_generation, transfer_id, request_id,
       target_account_id, previous_owner_account_id, fence_digest, state,
       intent_at, prepared_at, expires_at, updated_at
     ) VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 10, ?9, ?10, 20)`,
  );
  states.forEach((state, index) => {
    const filled = state !== 'intent';
    insert.run(
      roomCode(index),
      filled ? 1 : null,
      filled ? `transfer_${String(index).padStart(22, '0')}` : null,
      `state_request_${String(index).padStart(4, '0')}`,
      TARGET,
      filled ? PREVIOUS_OWNER : null,
      filled ? FENCE_DIGEST : null,
      state,
      filled ? 15 : null,
      NOW * 10,
    );
  });
}

function sagaRows(database: SqliteD1) {
  return database.rows<{ room_code: string; state: string; updated_at: number }>(
    `SELECT room_code, state, updated_at FROM ${SAGA_TABLE} ORDER BY room_code`,
  );
}

function adminNamespace(answer: (roomCode: string, roomGeneration: number) => Response) {
  const statusReads: string[] = [];
  return {
    statusReads,
    namespace: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          const code = request.headers.get('x-mxqr-pro-room-code') || '';
          const generation = Number(request.headers.get('x-mxqr-pro-room-generation') || '');
          if (new URL(request.url).pathname === '/internal/admin/status') statusReads.push(code);
          return answer(code, generation);
        },
      }),
    },
  };
}

describe('owner-transfer saga states: one TypeScript list', () => {
  const { states, nonterminal, terminal, ranked } = ownerTransferSagaStatesForTests();

  it('matches the state CHECK in the saga migration', () => {
    expect(sagaStateCheck(trackedSql('admin-metrics.owner-transfer-saga.migration.sql'))).toEqual(
      states,
    );
  });

  it('matches the state CHECK in the fresh-install admin schema', () => {
    expect(sagaStateCheck(trackedSql('admin-metrics.schema.sql'))).toEqual(states);
  });

  (nodeSqlite ? it : it.skip)(
    'matches the state CHECK that ensureAdminProRoomRegistry creates',
    async () => {
      const database = adminDatabase('');
      await expect(ensureAdminProRoomRegistryForTests(database)).resolves.toBe(true);
      const [table] = database.rows<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1`,
        SAGA_TABLE,
      );
      expect(sagaStateCheck(table?.sql ?? '')).toEqual(states);
    },
  );

  it('splits the states into the ones the cron adopts and the terminal ones', () => {
    expect(nonterminal).toEqual([
      'intent',
      'prepared',
      'committed',
      'registry_active',
      'old_owner_edge_retired',
      'verified',
    ]);
    expect(terminal).toEqual(['complete', 'target_deleted', 'expired', 'superseded']);
    expect([...nonterminal, ...terminal].sort()).toEqual([...states].sort());
    // The ranked compare-and-swap covers the filled states, prepared to complete.
    expect(ranked).toEqual(
      states.slice(states.indexOf('prepared'), states.indexOf('complete') + 1),
    );
  });
});

(nodeSqlite ? describe : describe.skip)('owner-transfer saga states: generated SQL', () => {
  const { states, nonterminal } = ownerTransferSagaStatesForTests();

  it('lists and rotates exactly the nonterminal sagas', async () => {
    const database = adminDatabase(trackedSql('admin-metrics.schema.sql'));
    insertOneSagaPerState(database, states);
    const admin = adminNamespace(() => new Response('unavailable', { status: 503 }));

    await expect(
      reconcileOwnerTransferSagasForTests(
        { MUSIXQUARE_ADMIN_DB: database, PRO_ROOM_ADMIN_ROOMS: admin.namespace },
        database,
        NOW,
      ),
    ).resolves.toBe(0);

    const adopted = states.flatMap((state, index) =>
      nonterminal.some((candidate) => candidate === state) ? [roomCode(index)] : [],
    );
    expect([...admin.statusReads].sort()).toEqual(adopted);
    // Every adopted saga that made no progress rotates to the sweep time; the
    // terminal ones are neither read nor touched.
    expect(sagaRows(database)).toEqual(
      states.map((state, index) => ({
        room_code: roomCode(index),
        state,
        updated_at: adopted.includes(roomCode(index)) ? NOW : 20,
      })),
    );
  });

  it('supersedes a saga in every nonterminal state once its room is decommissioned', async () => {
    const database = adminDatabase(trackedSql('admin-metrics.schema.sql'));
    insertOneSagaPerState(database, states);
    const insertRoom = database.database.prepare(
      `INSERT INTO mxqr_pro_room_registry
         (room_code, label, status, activation_state, room_generation, created_at, updated_at)
       VALUES (?1, 'Decommissioned', 'decommissioned', 'unactivated', 0, 1, 1)`,
    );
    states.forEach((_, index) => insertRoom.run(roomCode(index)));
    const admin = adminNamespace((code, generation) =>
      Response.json({
        roomCode: code,
        roomGeneration: generation,
        provisioned: false,
        status: 'decommissioned',
        suspensionReason: null,
        ownerAccountLinked: false,
        ownerAccountId: null,
        ownerTransferReconciliation: null,
      }),
    );

    await expect(
      reconcileOwnerTransferSagasForTests(
        { MUSIXQUARE_ADMIN_DB: database, PRO_ROOM_ADMIN_ROOMS: admin.namespace },
        database,
        NOW,
      ),
    ).resolves.toBe(nonterminal.length);

    expect(sagaRows(database).map(({ state }) => state)).toEqual(
      states.map((state) =>
        nonterminal.some((candidate) => candidate === state) ? 'superseded' : state,
      ),
    );
  });
});
