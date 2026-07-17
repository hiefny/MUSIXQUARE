import { describe, expect, it } from 'vitest';
import runtimeSource from '../runtime.ts?raw';

describe('PRO room effects runtime contract', () => {
  it('serializes a successful API effects ACK and canonical refresh with human checkpoints', () => {
    expect(runtimeSource).toMatch(
      /pendingEffectsBroadcast = pending;\s*await enqueueEffectsMutation\(async \(\) => \{\s*await api\.ackDeveloperCommand\([\s\S]*?refreshPersistedEffectsUnlocked\(snapshot, \{ broadcast: true \}\)/,
    );
  });

  it('rechecks coordinator authority after the canonical effects read before broadcasting', () => {
    const start = runtimeSource.indexOf('async function refreshPersistedEffectsUnlocked');
    const end = runtimeSource.indexOf('async function refreshPersistedEffects(', start + 1);
    const implementation = runtimeSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(implementation.indexOf('await api.getEffects')).toBeLessThan(
      implementation.indexOf('options.broadcast'),
    );
    expect(implementation).toContain('!active');
    expect(implementation).toContain('!isCoordinator()');
    expect(implementation).toContain(
      'current.presence.coordinatorEpoch !== snapshot.presence.coordinatorEpoch',
    );
  });

  it('does not let an older command clear a newer pending canonical broadcast', () => {
    expect(runtimeSource).toContain('pendingEffectsBroadcast?.commandId === pending.commandId');
    expect(runtimeSource).toContain(
      'pendingEffectsBroadcast.coordinatorEpoch !== snapshot.presence.coordinatorEpoch',
    );
  });
});
