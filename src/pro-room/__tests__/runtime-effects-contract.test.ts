import { describe, expect, it } from 'vitest';
import { createDefaultRoomEffectsState } from '../../core/room-effects.ts';
import { RoomSettingsIntentTracker } from '../effects-reconciliation.ts';
import runtimeSource from '../runtime.ts?raw';

function settings(masterVolume = 1) {
  return { masterVolume, effects: createDefaultRoomEffectsState() };
}

describe('PRO room settings field intent', () => {
  it('adopts canonical defaults until there is an attributable local gesture', () => {
    const tracker = new RoomSettingsIntentTracker();
    const local = settings();
    tracker.reset(local);
    const canonical = settings(0.24);
    canonical.effects.reverb.mixPercent = 55;
    expect(tracker.reconcile(local, canonical)).toEqual(canonical);

    local.effects.equalizer.bandsDb[2] = 4;
    tracker.markChanged(local, 1);
    expect(tracker.reconcile(local, canonical)).toMatchObject({
      masterVolume: 0.24,
      effects: {
        reverb: { mixPercent: 55 },
        equalizer: { bandsDb: [0, 0, 4, 0, 0] },
      },
    });
  });

  it('rebases every changed field while preserving unrelated canonical fields', () => {
    const tracker = new RoomSettingsIntentTracker();
    const local = settings();
    tracker.reset(local);
    local.masterVolume = 0.65;
    local.effects.reverb.mixPercent = 45;
    local.effects.equalizer.bandsDb[0] = 3;
    local.effects.virtualBass.strengthPercent = 40;
    local.effects.virtualSurround.widthPercent = 140;
    local.effects.virtualTreble.enabled = true;
    tracker.markChanged(local, 1);

    const canonical = settings(0.8);
    canonical.effects.reverb.decaySeconds = 7;
    canonical.effects.equalizer.bandsDb[1] = -4;
    canonical.effects.virtualSurround.widthPercent = 80;
    expect(tracker.reconcile(local, canonical)).toEqual({
      masterVolume: 0.65,
      effects: {
        ...local.effects,
        reverb: { ...local.effects.reverb, decaySeconds: 7 },
        equalizer: { bandsDb: [3, -4, 0, 0, 0] },
      },
    });
  });

  it('does not revive a retained canceled volume through a new EQ gesture', () => {
    const tracker = new RoomSettingsIntentTracker();
    const local = settings();
    tracker.reset(local);
    local.masterVolume = 0.4;
    tracker.markChanged(local, 1);
    tracker.reset(local);
    local.effects.equalizer.bandsDb[1] = -5;
    tracker.markChanged(local, 2);
    const canonical = settings(0.8);
    canonical.effects.reverb.mixPercent = 35;
    expect(tracker.reconcile(local, canonical)).toMatchObject({
      masterVolume: 0.8,
      effects: {
        reverb: { mixPercent: 35 },
        equalizer: { bandsDb: [0, -5, 0, 0, 0] },
      },
    });
  });

  it('allows a fresh gesture to return to the same value as a retired edit', () => {
    const tracker = new RoomSettingsIntentTracker();
    const local = settings(0.4);
    tracker.reset(local);
    local.masterVolume = 0.6;
    tracker.markChanged(local, 2);
    local.masterVolume = 0.4;
    tracker.markChanged(local, 3);
    expect(tracker.reconcile(local, settings(0.8)).masterVolume).toBe(0.4);
  });

  it('settles only fields owned by an old attempt while keeping newer gestures', () => {
    const tracker = new RoomSettingsIntentTracker();
    const local = settings();
    tracker.reset(local);
    local.masterVolume = 0.4;
    local.effects.equalizer.bandsDb[0] = 3;
    tracker.markChanged(local, 1);
    local.effects.reverb.mixPercent = 31;
    local.effects.equalizer.bandsDb[0] = 5;
    tracker.markChanged(local, 2);
    tracker.settle(1);
    expect(tracker.reconcile(local, settings(0.8))).toMatchObject({
      masterVolume: 0.8,
      effects: { reverb: { mixPercent: 31 }, equalizer: { bandsDb: [5, 0, 0, 0, 0] } },
    });
    tracker.settle(2);
    expect(tracker.reconcile(local, settings(0.8))).toEqual(settings(0.8));
  });

  it('observes canonical projection without claiming it as another local gesture', () => {
    const tracker = new RoomSettingsIntentTracker();
    const local = settings();
    tracker.reset(local);
    local.effects.equalizer.bandsDb[0] = 3;
    tracker.markChanged(local, 1);
    const remote = settings(0.8);
    remote.effects.reverb.mixPercent = 50;
    const projected = tracker.reconcile(local, remote);
    tracker.observe(projected);
    projected.effects.equalizer.bandsDb[1] = 5;
    tracker.markChanged(projected, 2);
    remote.masterVolume = 0.7;
    remote.effects.reverb.mixPercent = 60;
    expect(tracker.reconcile(projected, remote)).toMatchObject({
      masterVolume: 0.7,
      effects: { reverb: { mixPercent: 60 }, equalizer: { bandsDb: [3, 5, 0, 0, 0] } },
    });
  });

  it('clears previous session ownership when revision numbering restarts', () => {
    const tracker = new RoomSettingsIntentTracker();
    const old = settings();
    tracker.reset(old);
    old.masterVolume = 0.4;
    tracker.markChanged(old, 10);
    const successor = settings(0.8);
    tracker.reset(successor);
    successor.effects.reverb.mixPercent = 31;
    tracker.markChanged(successor, 1);
    expect(tracker.reconcile(successor, settings(0.7))).toMatchObject({
      masterVolume: 0.7,
      effects: { reverb: { mixPercent: 31 } },
    });
  });

  it('publishes all retained local settings only for explicit OFF-to-ON takeover', () => {
    const tracker = new RoomSettingsIntentTracker();
    const local = settings(0.4);
    local.effects.reverb.mixPercent = 31;
    tracker.reset(local);
    const canonical = settings(0.8);
    const takeover = tracker.reconcile(local, canonical, true);
    expect(takeover).toEqual(local);
    takeover.effects.reverb.mixPercent = 75;
    expect(local.effects.reverb.mixPercent).toBe(31);
    expect(tracker.reconcile(local, canonical)).toEqual(canonical);
  });
});

describe('PRO room effects runtime contract', () => {
  it('uses revision CAS and refreshes same-epoch resources only when their heads advance', () => {
    expect(runtimeSource).toContain('baseRevision: base.revision');
    expect(runtimeSource).toContain("error.code === 'SETTINGS_SYNC_REVISION_CONFLICT'");
    expect(runtimeSource).toContain('snapshot.effectsRevision > acceptedEffects.revision');
    expect(runtimeSource).toContain('snapshot.queueModeRevision > acceptedQueueMode.revision');
    expect(runtimeSource).toContain(
      'acceptCanonicalRoomSettings(effects, masterVolume, { notifyRemoteChange })',
    );
    expect(runtimeSource).toContain("'state:audio.exciter'");
    expect(runtimeSource).toContain('let desired = captureRoomEffectsState()');
    expect(runtimeSource).toContain('hasEffectsCheckpointAuthority');
    expect(runtimeSource).toContain('scheduleEffectsCheckpointRetry');
  });
});
