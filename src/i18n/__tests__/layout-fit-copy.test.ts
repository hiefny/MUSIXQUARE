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

  it('names the Tamil host-unresponsive title in words that fit a 320px dialog', () => {
    // The host-unresponsive dialog title (keep-open-notice.ts) took three
    // lines at 320px and its longest word ran 2.4px past the dialog.
    // The new title reads "the host device is not answering" in two lines
    // with every word whole; the dialog title's overflow-wrap is the net for
    // anything longer.
    const ta = APP_DICTIONARIES.ta;
    expect(ta['dialog.host_unresponsive_title']).toBe('ஹோஸ்ட் சாதனம் பதில் தரவில்லை');
    expect(ta['dialog.host_unresponsive_title']).not.toContain('சாதனத்திலிருந்து');
  });

  it('labels the Tamil and Malayalam tour exit in words that fit beside its 20px icon', () => {
    // The demo's last step pairs Exit Tour with Track info in 128px pills at
    // 320px (13px labels, 10px side padding, a 20px icon 10px from the label).
    // டெமோவிலிருந்து வெளியேறு ran 4.8px out of its pill there and squeezed
    // the icon to nothing; ഡെമോയിൽ നിന്ന് പുറത്തുകടക്കുക took three lines
    // with no icon. With the icon kept at 20px both ran further out. Tamil
    // now says leave (வெளியேறு, its common.leave) and Malayalam "leave the
    // demo" (ഡെമോ വിടുക), both inside the pill from 320px.
    const { ta, ml } = APP_DICTIONARIES;
    expect(ta['demo.exit']).toBe('வெளியேறு');
    expect(ta['demo.exit']).toBe(ta['common.leave']);
    expect(ml['demo.exit']).toBe('ഡെമോ വിടുക');
  });
});
