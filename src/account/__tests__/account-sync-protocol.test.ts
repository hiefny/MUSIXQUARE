/**
 * The one account pulse parser (registry RO-28; structural plan C8-I4).
 *
 * Before C8-I4 the app tab parsed pulses twice: session.ts kept
 * `{ id, loginSuccess }` for any `type: 'refresh'` message (id only within
 * 8..160 characters), and ui/account.ts accepted only a completion result with
 * a known accountAuth and an id and accountClient of 8..160 characters. These
 * rows are the union of both validators. Each states the parsed pulse and the
 * two projections the receivers make from it, which equal the old parsers'
 * results; account-pulse-contract.test.ts pins the receivers end to end. The
 * events page keeps its own inline check (another document, owner decision O6).
 */
import { describe, expect, it } from 'vitest';
import { parseAccountPulse, parseAccountPulseStorageValue } from '../account-sync-protocol.ts';

type Pulse = ReturnType<typeof parseAccountPulse>;

/** session.ts reconciles `id` and treats only accountAuth 'success' as a login result. */
function sessionProjection(pulse: Pulse) {
  return pulse ? { id: pulse.id, loginSuccess: pulse.auth === 'success' } : null;
}

/** ui/account.ts handles a result only with an outcome, an id and an accountClient. */
function uiProjection(pulse: Pulse) {
  return pulse?.auth && pulse.id !== null && pulse.accountClient !== null
    ? { outcome: pulse.auth, id: pulse.id, accountClient: pulse.accountClient }
    : null;
}

const ID = 'result:parser-0001';
const CLIENT = 'client-parser-0001';
const completion = (fields: Record<string, unknown> = {}) => ({
  type: 'refresh',
  accountAuth: 'success',
  id: ID,
  accountClient: CLIENT,
  ...fields,
});
const withoutField = (field: string) => {
  const message: Record<string, unknown> = completion();
  delete message[field];
  return message;
};

type Row = readonly [
  label: string,
  value: unknown,
  pulse: Pulse,
  session: ReturnType<typeof sessionProjection>,
  ui: ReturnType<typeof uiProjection>,
];

const SUCCESS = { id: ID, auth: 'success', accountClient: CLIENT } as const;

const MESSAGE_ROWS: readonly Row[] = [
  [
    'a completion success',
    completion(),
    SUCCESS,
    { id: ID, loginSuccess: true },
    { outcome: 'success', id: ID, accountClient: CLIENT },
  ],
  [
    'a completion cancellation',
    completion({ accountAuth: 'cancelled' }),
    { ...SUCCESS, auth: 'cancelled' },
    { id: ID, loginSuccess: false },
    { outcome: 'cancelled', id: ID, accountClient: CLIENT },
  ],
  [
    'a completion error',
    completion({ accountAuth: 'error' }),
    { ...SUCCESS, auth: 'error' },
    { id: ID, loginSuccess: false },
    { outcome: 'error', id: ID, accountClient: CLIENT },
  ],
  [
    'a mutation pulse',
    { type: 'refresh', id: 'refresh:parser-0001' },
    { id: 'refresh:parser-0001', auth: null, accountClient: null },
    { id: 'refresh:parser-0001', loginSuccess: false },
    null,
  ],
  [
    'a legacy pulse without an id',
    { type: 'refresh' },
    { id: null, auth: null, accountClient: null },
    { id: null, loginSuccess: false },
    null,
  ],
  [
    'an id of 7 characters',
    completion({ id: 'r'.repeat(7) }),
    { ...SUCCESS, id: null },
    { id: null, loginSuccess: true },
    null,
  ],
  [
    'an id of 8 characters',
    completion({ id: 'r'.repeat(8) }),
    { ...SUCCESS, id: 'r'.repeat(8) },
    { id: 'r'.repeat(8), loginSuccess: true },
    { outcome: 'success', id: 'r'.repeat(8), accountClient: CLIENT },
  ],
  [
    'an id of 160 characters',
    completion({ id: 'r'.repeat(160) }),
    { ...SUCCESS, id: 'r'.repeat(160) },
    { id: 'r'.repeat(160), loginSuccess: true },
    { outcome: 'success', id: 'r'.repeat(160), accountClient: CLIENT },
  ],
  [
    'an id of 161 characters',
    completion({ id: 'r'.repeat(161) }),
    { ...SUCCESS, id: null },
    { id: null, loginSuccess: true },
    null,
  ],
  [
    'a numeric id',
    completion({ id: 12_345_678 }),
    { ...SUCCESS, id: null },
    { id: null, loginSuccess: true },
    null,
  ],
  ['no id', withoutField('id'), { ...SUCCESS, id: null }, { id: null, loginSuccess: true }, null],
  [
    'an unknown accountAuth',
    completion({ accountAuth: 'pending' }),
    { ...SUCCESS, auth: null },
    { id: ID, loginSuccess: false },
    null,
  ],
  [
    'an accountAuth of another case',
    completion({ accountAuth: 'Success' }),
    { ...SUCCESS, auth: null },
    { id: ID, loginSuccess: false },
    null,
  ],
  [
    'no accountClient',
    withoutField('accountClient'),
    { ...SUCCESS, accountClient: null },
    { id: ID, loginSuccess: true },
    null,
  ],
  [
    'a null accountClient (a completion URL without one)',
    completion({ accountClient: null }),
    { ...SUCCESS, accountClient: null },
    { id: ID, loginSuccess: true },
    null,
  ],
  [
    'an accountClient of 7 characters',
    completion({ accountClient: 'c'.repeat(7) }),
    { ...SUCCESS, accountClient: null },
    { id: ID, loginSuccess: true },
    null,
  ],
  [
    'an accountClient of 8 characters',
    completion({ accountClient: 'c'.repeat(8) }),
    { ...SUCCESS, accountClient: 'c'.repeat(8) },
    { id: ID, loginSuccess: true },
    { outcome: 'success', id: ID, accountClient: 'c'.repeat(8) },
  ],
  [
    'an accountClient of 160 characters',
    completion({ accountClient: 'c'.repeat(160) }),
    { ...SUCCESS, accountClient: 'c'.repeat(160) },
    { id: ID, loginSuccess: true },
    { outcome: 'success', id: ID, accountClient: 'c'.repeat(160) },
  ],
  [
    'an accountClient of 161 characters',
    completion({ accountClient: 'c'.repeat(161) }),
    { ...SUCCESS, accountClient: null },
    { id: ID, loginSuccess: true },
    null,
  ],
  [
    'a numeric accountClient',
    completion({ accountClient: 12_345_678 }),
    { ...SUCCESS, accountClient: null },
    { id: ID, loginSuccess: true },
    null,
  ],
  ['another type', completion({ type: 'refreshed' }), null, null, null],
  ['no type', withoutField('type'), null, null, null],
  ['a bare string', 'refresh', null, null, null],
  ['an array', [{ type: 'refresh', id: ID }], null, null, null],
  ['a number', 42, null, null, null],
  ['null', null, null, null, null],
  ['undefined', undefined, null, null, null],
];

describe('parseAccountPulse (BroadcastChannel and window messages)', () => {
  it.each(MESSAGE_ROWS)('%s', (_, value, pulse, session, ui) => {
    const parsed = parseAccountPulse(value);
    expect(parsed).toEqual(pulse);
    expect(sessionProjection(parsed)).toEqual(session);
    expect(uiProjection(parsed)).toEqual(ui);
  });

  it('ignores fields outside the contract', () => {
    expect(parseAccountPulse(completion({ account: { nickname: 'Minsu' } }))).toEqual(SUCCESS);
  });
});

/**
 * The storage event carries a string, or null when the key was removed. The
 * session receiver reconciles every value of its key, as an unidentified
 * refresh when the parser returns null (session.ts
 * reconcileExternalAccountChange(null)); the account UI ignores a null.
 */
const STORAGE_ROWS: ReadonlyArray<readonly [label: string, value: string | null, pulse: Pulse]> = [
  ['the completion JSON', JSON.stringify(completion()), SUCCESS],
  [
    'a mutation JSON',
    JSON.stringify({ type: 'refresh', id: 'refresh:parser-0001' }),
    { id: 'refresh:parser-0001', auth: null, accountClient: null },
  ],
  ['a legacy opaque token', 'legacy-opaque-token-0001', null],
  ['JSON that is not a pulse', '{"type":"other"}', null],
  ['a JSON number', '42', null],
  ['JSON null', 'null', null],
  ['a JSON array', JSON.stringify([{ type: 'refresh', id: ID }]), null],
  ['an empty string', '', null],
  ['removal of the key', null, null],
];

describe('parseAccountPulseStorageValue (storage events)', () => {
  it.each(STORAGE_ROWS)('%s', (_, value, pulse) => {
    expect(parseAccountPulseStorageValue(value)).toEqual(pulse);
  });

  it('reads a stored completion exactly as the same message', () => {
    for (const [, value] of MESSAGE_ROWS) {
      if (value === undefined) continue;
      expect(parseAccountPulseStorageValue(JSON.stringify(value))).toEqual(
        parseAccountPulse(value),
      );
    }
  });
});
