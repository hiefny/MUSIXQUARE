/**
 * The bootstrap's wait for the app stylesheet (src/app.ts).
 *
 * The parser places the app stylesheet in <body>, ahead of the entry module
 * script (index.html, and the build's render-assets slot in vite.config.ts).
 * The HTML standard holds a deferred or module script until such a sheet has
 * loaded or failed, and Chromium does; WebKit runs the module graph at once
 * (seen at about 0.1 s with a sheet held back 1.5 s). Every bootstrap step
 * expects the styled page: setup's boot-failure check reads the sheet's
 * failure surface, which unstyled reads as shown, and setup's release hands
 * the boot splash's screen to the app. So the bootstrap waits for the sheet
 * itself, as Chromium would have.
 *
 * It adds no deadline of its own: a sheet that never settles leaves the boot
 * to the same 15 s fallbacks as in Chromium (style.css and fouc-cleanup.js).
 * A sheet that failed before the wait began fires nothing more. Chromium and
 * WebKit give it an empty sheet, so nothing waits; where it stays null, the
 * page's load event, which follows every stylesheet the parser placed, ends
 * the wait. Sheets a script adds later (the language fonts) go to <head> and
 * never held the module in Chromium, so they are not waited for here either.
 */
export function whenAppStylesheetsSettled(): Promise<void> {
  const pending = [
    ...document.querySelectorAll<HTMLLinkElement>('body link[rel~="stylesheet"]'),
  ].filter((link) => !link.sheet);
  if (pending.length === 0 || document.readyState === 'complete') return Promise.resolve();

  const listening = new AbortController();
  const options = { once: true, signal: listening.signal };
  const sheets = pending.map(
    (link) =>
      new Promise<void>((resolve) => {
        link.addEventListener('load', () => resolve(), options);
        link.addEventListener('error', () => resolve(), options);
      }),
  );
  const page = new Promise<void>((resolve) => {
    window.addEventListener('load', () => resolve(), options);
  });
  return Promise.race([Promise.all(sheets), page]).then(() => listening.abort());
}
