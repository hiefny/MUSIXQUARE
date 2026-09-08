# Translation workspace

The public `/translate` editor uses the document style shared by FAQ, Privacy,
Terms, and Developers. It provides direct phrase editing, without a separate
recruitment landing page. Its interface is English.

## Run and publish

Use `npm run dev` and open `/translate`. The isolated editor is also available:

```powershell
node node_modules/vite/bin/vite.js --config .workshop/translate/dev/preview.config.ts
```

The isolated server uses `http://127.0.0.1:4317/translate`, adds noindex headers,
and does not connect production APIs. Public `/translate` has an English
self-canonical URL; there are no 42 localized page copies.

The normal checked build produces `dist/translate.html`, its script and styles,
`/translation-catalogs.json`, and content-hashed locale JSON assets. The App Worker
serves the public route and normalizes slash/HTML aliases. Publish through the
ordinary exact-commit App release workflow in `docs/hotfix-procedure.md`.

## Editing and storage

- 40 target languages, with English and Korean references.
- Actual App/About strings: currently 728 App and 74 About keys per locale.
  The generator validates source key sets dynamically.
- Search, page filtering, reference comparison, optional explanation, character
  count, and a plain text wording preview up to 320 pixels wide.
- Automatic local drafts, restored drafts, and explicit draft removal.
- Exact placeholder counts and existing markup/attribute protection.
- Explicit re-review of changed references and fresh catalog checks before export.
- Versioned JSON containing original text, suggestion, locale, key, reason, and
  timestamps. A readonly JSON field remains available if a browser skips downloads.

Translations use textContent/value. The wording preview only replaces literal
`<br>` notation with line breaks; imported HTML is never rendered.

Drafts use localStorage key `musixquare.translate.drafts.v1`, specific to the
browser and origin. Local preview drafts are not copied to production. Clearing
browser data removes them. Limits are 1,000 drafts, 1 MiB storage, and 8 MiB export.
Export includes valid complete proposals; unfinished drafts remain in the editor.

When another tab changes stored drafts, automatic saving pauses in this tab.
In-memory work remains available for export before reloading the latest saved
state. Storage failures are shown explicitly. This overwrite guard is not a
multi-user collaboration system.

Catalog reads omit credentials, bypass caches, and have a bounded deadline. The
build parses literal TypeScript dictionaries without executing app/About scripts.
Restart a development preview after editing translation sources.

## Current contribution boundary

This editor prepares suggestions. It does not automatically submit, approve, or
apply translations, and the UI says so. Weblate, reviewer accounts, and server-side
submission are not connected. Separate plural forms, account messages, and other
page families are outside the App/About catalog.

## Sources and checks

- `translate.html` / `translate.css`: document layout and editor controls.
- `main.ts`: selection, references, editing, and export UI.
- `drafts.ts` / `storage-session.ts`: validation and storage boundaries.
- `catalog-client.ts`: static manifest and locale reads.
- `scripts/translation-catalog.ts`: literal source extraction.
- `scripts/translation-catalog-assets.ts`: build/dev asset generation.
- `dev/`: isolated preview and legacy read-only preview endpoint.

Existing workshop/tooling TypeScript and ESLint projects include these files.
Vitest covers drafts, export, storage conflicts, catalog packaging, navigation,
Worker routes, and service-worker behavior. Local browser/preparation evidence is
under `scratch/translate-preview-2026-09-08/`.
