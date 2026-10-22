import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureAdminProRoomRegistryForTests,
  isFenceDigestForTests,
  ownerTransferSagaStatesForTests,
  reconcileOwnerTransferSagasForTests,
} from '../../../cloudflare/app-worker.ts';
import { nodeSqlite, SqliteD1, trackedSql } from './helpers/worker-test-bindings.ts';

/**
 * Drift guard for the owner-transfer saga states (resource RO-09 in
 * docs/design/resource-ownership-registry.md, plan step C7-2b) and the
 * Developer API fence digest pattern (RO-25).
 *
 * The App Worker names the states once (OWNER_TRANSFER_SAGA_STATES and its
 * nonterminal, terminal, abandoned and ranked subsets) and builds its SQL
 * state lists from them. Three SQL copies of the full list stay as written,
 * because D1 migrations and the runtime DDL own them: the migration that
 * added the table, the fresh-install schema, and ensureAdminProRoomRegistry.
 * This file keeps all three equal to the TypeScript list, and runs the
 * generated cron listing, rotation and decommission terminalization SQL in
 * node:sqlite. The fence digest pattern (FENCE_DIGEST_RE) is checked against
 * the D1 CHECK constraints that spell the same shape in SQL.
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

function adminDatabase(schemaSql: string, name = 'admin') {
  const database = new SqliteD1(name, schemaSql);
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
  const { states, nonterminal, terminal, abandoned, ranked } = ownerTransferSagaStatesForTests();

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
    // The terminal states in which the transfer did not complete.
    expect(abandoned).toEqual(['target_deleted', 'expired', 'superseded']);
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
    insertDecommissionedRooms(database, states.length);
    const admin = adminNamespace(decommissionedStatus);

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

  it('leaves a saga that another executor ended during the sweep in its terminal state', async () => {
    const database = adminDatabase(trackedSql('admin-metrics.schema.sql'));
    insertOneSagaPerState(database, states);
    insertDecommissionedRooms(database, states.length);
    // Between the cron listing and its terminalize write, another executor
    // ends each listed saga: the unfilled intent expires, and each filled one
    // ends in a terminal state other than 'superseded' (terminalize's own).
    const otherEnds = ['complete', 'target_deleted', 'expired'];
    const endedState = (state: string, index: number) =>
      state === 'intent' ? 'expired' : (otherEnds[index % otherEnds.length] ?? 'complete');
    const end = database.database.prepare(
      `UPDATE ${SAGA_TABLE} SET state = ?1 WHERE room_code = ?2`,
    );
    const admin = adminNamespace((code, generation) => {
      const index = Number(code) - 100;
      end.run(endedState(states[index] ?? '', index), code);
      return decommissionedStatus(code, generation);
    });

    await expect(
      reconcileOwnerTransferSagasForTests(
        { MUSIXQUARE_ADMIN_DB: database, PRO_ROOM_ADMIN_ROOMS: admin.namespace },
        database,
        NOW,
      ),
    ).resolves.toBe(0);

    expect(admin.statusReads).toHaveLength(nonterminal.length);
    // Neither the terminalize write (nonterminal states only) nor the rotation
    // (the listed state only) touches a saga that is already terminal.
    expect(sagaRows(database)).toEqual(
      states.map((state, index) => ({
        room_code: roomCode(index),
        state: nonterminal.some((candidate) => candidate === state)
          ? endedState(state, index)
          : state,
        updated_at: 20,
      })),
    );
  });
});

describe('Developer API fence digest: one pattern', () => {
  // Each candidate with whether it is a fence digest: 43 characters of
  // [A-Za-z0-9_-] (unpadded base64url of a SHA-256 HMAC).
  const candidates: ReadonlyArray<readonly [string, boolean]> = [
    ['A'.repeat(43), true],
    [`${'a'.repeat(20)}-_${'9'.repeat(21)}`, true],
    ['A'.repeat(42), false],
    ['A'.repeat(44), false],
    ...['+', '/', '=', '.', ' ', String.fromCharCode(0xe9)].map(
      (character) => [`${'A'.repeat(42)}${character}`, false] as const,
    ),
    ['', false],
  ];

  it('accepts exactly the 43-character base64url digests', () => {
    expect(candidates.map(([digest]) => isFenceDigestForTests(digest))).toEqual(
      candidates.map(([, valid]) => valid),
    );
  });

  it('spells the same CHECK in every tracked SQL definition', () => {
    for (const file of [
      'admin-metrics.owner-transfer-saga.migration.sql',
      'admin-metrics.schema.sql',
      'developer-api.authority-fence.migration.sql',
      'developer-api.schema.sql',
    ]) {
      const sql = trackedSql(file);
      expect(sql.match(/length\(fence_digest\) = 43/g), file).toHaveLength(1);
      expect(sql.match(/fence_digest NOT GLOB '\*\[\^A-Za-z0-9_-\]\*'/g), file).toHaveLength(1);
    }
  });

  (nodeSqlite ? it : it.skip)('agrees with the D1 CHECK of the fence and saga rows', async () => {
    const developer = adminDatabase(trackedSql('developer-api.schema.sql'), 'developer');
    const freshInstall = adminDatabase(trackedSql('admin-metrics.schema.sql'));
    const runtimeDdl = adminDatabase('');
    await expect(ensureAdminProRoomRegistryForTests(runtimeDdl)).resolves.toBe(true);

    candidates.forEach(([digest], generation) => {
      const valid = isFenceDigestForTests(digest);
      expect(
        storesDigest(() => insertFenceRow(developer, generation, digest)),
        digest,
      ).toBe(valid);
      for (const database of [freshInstall, runtimeDdl]) {
        expect(
          storesDigest(() => insertFilledSaga(database, generation, digest)),
          digest,
        ).toBe(valid);
      }
    });
  });
});

/** Whether a row insert passed the table's CHECK constraints. */
function storesDigest(insert: () => void) {
  try {
    insert();
    return true;
  } catch (error) {
    if (/CHECK constraint failed/i.test(String(error))) return false;
    throw error;
  }
}

function insertFenceRow(database: SqliteD1, roomGeneration: number, fenceDigest: string) {
  database.database
    .prepare(
      `INSERT INTO mxqr_developer_api_room_authority_fences
         (room_code, room_generation, status, reason, fence_digest, fenced_at, updated_at)
       VALUES ('000100', ?1, 'active', 'ownership_transfer_pending', ?2, 1, 1)`,
    )
    .run(roomGeneration, fenceDigest);
}

function insertFilledSaga(database: SqliteD1, roomGeneration: number, fenceDigest: string) {
  database.database
    .prepare(
      `INSERT INTO ${SAGA_TABLE} (
         room_code, room_generation, claim_generation, transfer_id, request_id,
         target_account_id, previous_owner_account_id, fence_digest, state,
         intent_at, prepared_at, expires_at, updated_at
       ) VALUES ('000100', ?1, 1, ?2, 'digest_request_0001', ?3, ?4, ?5, 'prepared',
                 10, 15, ?6, 20)`,
    )
    .run(
      roomGeneration,
      `transfer_${String(roomGeneration).padStart(22, '0')}`,
      TARGET,
      PREVIOUS_OWNER,
      fenceDigest,
      NOW * 10,
    );
}

function insertDecommissionedRooms(database: SqliteD1, count: number) {
  const insertRoom = database.database.prepare(
    `INSERT INTO mxqr_pro_room_registry
       (room_code, label, status, activation_state, room_generation, created_at, updated_at)
     VALUES (?1, 'Decommissioned', 'decommissioned', 'unactivated', 0, 1, 1)`,
  );
  for (let index = 0; index < count; index += 1) insertRoom.run(roomCode(index));
}

function decommissionedStatus(code: string, generation: number) {
  return Response.json({
    roomCode: code,
    roomGeneration: generation,
    provisioned: false,
    status: 'decommissioned',
    suspensionReason: null,
    ownerAccountLinked: false,
    ownerAccountId: null,
    ownerTransferReconciliation: null,
  });
}
