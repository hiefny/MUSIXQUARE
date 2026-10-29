import { describe, expect, it } from 'vitest';

import { APP_DICTIONARIES } from '../catalogs.ts';

/**
 * Translations chosen so a fixed slot holds them (owner decisions 2026-10-29).
 * Each pin names the slot and what the previous copy did there, so a later
 * edit to the copy knows what it has to fit.
 */
describe('copy that fits its slot', () => {
  it('reads 準備中... in the Japanese setup waiting pill', () => {
    // The pill beside Back on the setup screen (setup-host.ts, setup-guest.ts)
    // is 86px wide at 320px and has no side padding. お待ちください...
    // (111.64px) wrapped to two lines below 346px and touched the pill's
    // edges. 準備中... ("preparing") is the app's own word for a state that
    // is getting ready (player.not_ready_tip) and fits from 320px. The key
    // is also the account window's loading line and the YouTube search's busy
    // label, where it reads as well.
    const ja = APP_DICTIONARIES.ja;
    expect(ja['common.wait']).toBe('準備中...');
    expect(ja['player.not_ready_tip']).toContain('準備中');
  });
});
