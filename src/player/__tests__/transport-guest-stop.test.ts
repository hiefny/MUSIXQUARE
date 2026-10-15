/** @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import type { DataConnection } from '../../types/index.ts';
import { stopPlayback } from '../transport.ts';

const QUEUE_ITEM = '91400000-0000-4000-8000-000000000001';

beforeEach(() => {
  resetState();
});

it('asks the host to pause before it seeks to the start', () => {
  const send = vi.fn();
  const hostConn = { peer: 'host', open: true, send } as unknown as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', hostConn);
  setState('network.isOperator', true);
  setState('playlist.currentQueueItemId', QUEUE_ITEM);

  stopPlayback();

  // A hidden host refuses a seek while its local file plays, but applies a
  // paused seek. Pausing first keeps the stop whole in either case.
  expect(send.mock.calls.map(([msg]) => msg)).toEqual([
    { type: MSG.REQUEST_PAUSE, queueItemId: QUEUE_ITEM },
    { type: MSG.REQUEST_SEEK, time: 0, queueItemId: QUEUE_ITEM },
  ]);
});
