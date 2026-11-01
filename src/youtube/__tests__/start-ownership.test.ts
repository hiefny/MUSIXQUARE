/**
 * The YouTube start ledger (src/youtube/start-ownership.ts), through its
 * production exports only: the start owners register their live queries with
 * registerYouTubeStartClaim, and the derived queries isYouTubeStartSyncOwned
 * and isYouTubeStartHardMuteOwned answer from them.
 *
 * Every live query here is a recorded stand-in whose answer the row sets, so
 * a row shows which claim position decides which derived query, the order
 * and short-circuit of the reads, and that every answer is read at the call
 * (the ledger keeps none of its own). The real owners' queries, read through
 * the real wiring, are the truth tables' job (youtube-start-ownership-table
 * and youtube-start-ownership-table-pro).
 *
 * The ledger keeps its registrations for the life of its module instance, so
 * every test imports a fresh one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let ledger: typeof import('../start-ownership.ts');

beforeEach(async () => {
  vi.resetModules();
  ledger = await import('../start-ownership.ts');
});

/** Every live query a claim registers, as '<kind>.<position>'. */
const QUERIES = [
  'standard-run.inFlight',
  'standard-run.protocolActive',
  'standard-run.hardMuted',
  'standard-recovery.active',
  'standard-recovery.pending',
  'legacy-rendezvous.stage2Pending',
  'pro-arm.hardMuted',
  'pro-direct.waiting',
] as const;
type QueryName = (typeof QUERIES)[number];

interface RecordedOwners {
  /** Every query read, in order. */
  readonly reads: QueryName[];
  /** What each query answers now; a row may change it between two reads. */
  readonly answers: Record<QueryName, boolean>;
}

/** Register every claim kind with recorded stand-ins; `trueQueries` answer true. */
function registerOwners(trueQueries: readonly QueryName[] = []): RecordedOwners {
  const reads: QueryName[] = [];
  const answers = Object.fromEntries(
    QUERIES.map((name) => [name, trueQueries.includes(name)]),
  ) as Record<QueryName, boolean>;
  const live = (name: QueryName) => () => {
    reads.push(name);
    return answers[name];
  };
  ledger.registerYouTubeStartClaim('standard-run', [
    live('standard-run.inFlight'),
    live('standard-run.protocolActive'),
    live('standard-run.hardMuted'),
  ]);
  ledger.registerYouTubeStartClaim('standard-recovery', [
    live('standard-recovery.active'),
    live('standard-recovery.pending'),
  ]);
  ledger.registerYouTubeStartClaim('legacy-rendezvous', [live('legacy-rendezvous.stage2Pending')]);
  ledger.registerYouTubeStartClaim('pro-arm', [live('pro-arm.hardMuted')]);
  ledger.registerYouTubeStartClaim('pro-direct', [live('pro-direct.waiting')]);
  return { reads, answers };
}

/** The derived queries that answer true now. */
function derived(): string[] {
  return [
    ...(ledger.isYouTubeStartSyncOwned() ? ['syncOwned'] : []),
    ...(ledger.isYouTubeStartHardMuteOwned() ? ['hardMuteOwned'] : []),
  ];
}

/** Every combination of the eight answers, as the queries that answer true. */
const COMBINATIONS: ReadonlyArray<readonly QueryName[]> = Array.from(
  { length: 2 ** QUERIES.length },
  (_, bits) => QUERIES.filter((_name, index) => (bits & (1 << index)) !== 0),
);

describe('start ledger: what each claim position decides', () => {
  it.each([
    ['standard-run.inFlight', []],
    ['standard-run.protocolActive', ['syncOwned']],
    ['standard-run.hardMuted', ['hardMuteOwned']],
    ['standard-recovery.active', ['hardMuteOwned']],
    ['standard-recovery.pending', ['syncOwned']],
    ['legacy-rendezvous.stage2Pending', []],
    ['pro-arm.hardMuted', ['hardMuteOwned']],
    ['pro-direct.waiting', []],
  ] as const)('%s alone holds %j', (query, expected) => {
    registerOwners([query]);
    expect(derived()).toEqual(expected);
  });

  it('holds nothing while every query answers false', () => {
    registerOwners();
    expect(derived()).toEqual([]);
  });

  it('holds both while every query answers true', () => {
    registerOwners(QUERIES);
    expect(derived()).toEqual(['syncOwned', 'hardMuteOwned']);
  });
});

describe('start ledger: read order and short-circuit', () => {
  /**
   * By (protocolActive, pending): the run's protocol first, as
   * isYouTubeZeroStartSyncOwned asks it, then the recovery's pending claim
   * only while the protocol is off. No other query is read.
   */
  const SYNC_OWNED: Record<string, { answer: boolean; reads: QueryName[] }> = {
    'false false': {
      answer: false,
      reads: ['standard-run.protocolActive', 'standard-recovery.pending'],
    },
    'false true': {
      answer: true,
      reads: ['standard-run.protocolActive', 'standard-recovery.pending'],
    },
    'true false': { answer: true, reads: ['standard-run.protocolActive'] },
    'true true': { answer: true, reads: ['standard-run.protocolActive'] },
  };

  /**
   * By (run hardMuted, recovery active, arm hardMuted): the order of
   * player.ts's guard before an unMute. No other query is read.
   */
  const ALL_THREE: QueryName[] = [
    'standard-run.hardMuted',
    'standard-recovery.active',
    'pro-arm.hardMuted',
  ];
  const HARD_MUTE_OWNED: Record<string, { answer: boolean; reads: QueryName[] }> = {
    'false false false': { answer: false, reads: ALL_THREE },
    'false false true': { answer: true, reads: ALL_THREE },
    'false true false': {
      answer: true,
      reads: ['standard-run.hardMuted', 'standard-recovery.active'],
    },
    'false true true': {
      answer: true,
      reads: ['standard-run.hardMuted', 'standard-recovery.active'],
    },
    'true false false': { answer: true, reads: ['standard-run.hardMuted'] },
    'true false true': { answer: true, reads: ['standard-run.hardMuted'] },
    'true true false': { answer: true, reads: ['standard-run.hardMuted'] },
    'true true true': { answer: true, reads: ['standard-run.hardMuted'] },
  };

  it('reads syncOwned the same way under all 256 combinations of the eight answers', () => {
    for (const trueQueries of COMBINATIONS) {
      const owners = registerOwners(trueQueries);
      const answer = ledger.isYouTubeStartSyncOwned();
      const key = [
        owners.answers['standard-run.protocolActive'],
        owners.answers['standard-recovery.pending'],
      ].join(' ');
      expect({ trueQueries, answer, reads: owners.reads }).toEqual({
        trueQueries,
        ...SYNC_OWNED[key],
      });
    }
  });

  it('reads hardMuteOwned the same way under all 256 combinations of the eight answers', () => {
    for (const trueQueries of COMBINATIONS) {
      const owners = registerOwners(trueQueries);
      const answer = ledger.isYouTubeStartHardMuteOwned();
      const key = [
        owners.answers['standard-run.hardMuted'],
        owners.answers['standard-recovery.active'],
        owners.answers['pro-arm.hardMuted'],
      ].join(' ');
      expect({ trueQueries, answer, reads: owners.reads }).toEqual({
        trueQueries,
        ...HARD_MUTE_OWNED[key],
      });
    }
  });
});

describe('start ledger: live queries only', () => {
  it('reads no query when a claim registers', () => {
    const owners = registerOwners(QUERIES);
    expect(owners.reads).toEqual([]);
    // Positive control: the same stand-ins are read once asked.
    expect(derived()).toEqual(['syncOwned', 'hardMuteOwned']);
    expect(owners.reads).not.toEqual([]);
  });

  it('answers each call from the queries as they answer at that call', () => {
    const owners = registerOwners();
    const trace: string[] = [];
    const read = () => trace.push(derived().join('+') || '-');
    // No registration, event or microtask between two reads: only the
    // stand-ins' answers change.
    read();
    owners.answers['standard-run.protocolActive'] = true;
    read();
    owners.answers['standard-run.protocolActive'] = false;
    owners.answers['standard-run.hardMuted'] = true;
    read();
    owners.answers['standard-run.hardMuted'] = false;
    owners.answers['standard-recovery.active'] = true;
    owners.answers['standard-recovery.pending'] = true;
    read();
    owners.answers['standard-recovery.active'] = false;
    read();
    owners.answers['standard-recovery.pending'] = false;
    owners.answers['pro-arm.hardMuted'] = true;
    read();
    owners.answers['pro-arm.hardMuted'] = false;
    read();
    expect(trace).toEqual([
      '-',
      'syncOwned',
      'hardMuteOwned',
      'syncOwned+hardMuteOwned',
      'syncOwned',
      'hardMuteOwned',
      '-',
    ]);
  });
});

describe('start ledger: registrations', () => {
  it('answers false and reads nothing before any claim registers', () => {
    expect(derived()).toEqual([]);
  });

  it('reads nothing of a kind that has not registered', () => {
    const reads: string[] = [];
    ledger.registerYouTubeStartClaim('pro-arm', [
      () => {
        reads.push('pro-arm.hardMuted');
        return true;
      },
    ]);
    expect(derived()).toEqual(['hardMuteOwned']);
    // syncOwned never asks the arm, and no other kind has registered.
    expect(reads).toEqual(['pro-arm.hardMuted']);
  });

  it('replaces a kind on a later registration of it', () => {
    const replaced = vi.fn(() => true);
    const current = vi.fn(() => false);
    ledger.registerYouTubeStartClaim('standard-run', [replaced, replaced, replaced]);
    ledger.registerYouTubeStartClaim('standard-run', [current, current, current]);
    expect(derived()).toEqual([]);
    expect(replaced).not.toHaveBeenCalled();
    // Positive control: the current claim answered both derived queries.
    expect(current).toHaveBeenCalledTimes(2);
  });
});
