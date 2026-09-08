# Translation workspace

The public `/translate` editor uses the document style shared by FAQ, Privacy,
Terms, and Developers. It provides direct phrase editing, without a separate
recruitment landing page. Its interface is English.

## Run and publish

Use `npm run dev` and open `/translate` for the static editor. Vite does not run
the account or community Worker APIs. The isolated editor is also available:

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

## Public suggestions and review

Anyone can browse language-scoped suggestions and sort by recommendations or
newest. Existing MUSIXQUARE Google accounts can submit a suggestion, recommend it
once, remove that recommendation, or withdraw their own unapplied suggestion.
Unsubmitted drafts remain local. Submissions preserve the exact English, Korean,
and current translation references and cannot be edited after publication.

The App Worker owns `/api/translations/suggestions`. It checks the deployed
catalog, wording constraints, account session scope, same-origin CSRF headers,
and account-based rate limits. Public responses expose display names and total
recommendations, never account IDs, emails, or voter identities. Lists are
paginated and `no-store`; rejected/withdrawn proposals are not publicly listed.

The protected `/admin` Translations tab provides recommendation-ordered review,
revision-checked approval/rejection, and approved JSON export. One proposal per
phrase can be approved at a time. Votes prioritize review; they do not change
shipped wording automatically. An approved export fails if any unapplied approval
has stale references; already applied approvals are omitted.

Apply a reviewed export from the repository root:

```text
npm run translation:apply -- path/to/MUSIXQUARE-approved-translations.json
npm run translation:apply -- path/to/MUSIXQUARE-approved-translations.json --write
```

The first command validates and previews. The second edits only the matching
translation string literals after checking every baseline and proposal. Review
the diff, run the normal checks, and publish through the App release workflow.
Ordinary browser draft exports are not approved bundles and cannot be applied
with this tool. Separate plural forms, account messages, and other page families
remain outside the App/About catalog.

The additive D1 tables and account-deletion behavior are documented in
`docs/account-auth-operations.md`. App releases apply and verify the migration
before deploying the Worker. Existing account/OAuth and admin protections are
reused; no separate translation login or database is required.

## Sources and checks

- `translate.html` / `translate.css`: document layout and editor controls.
- `main.ts`: selection, references, editing, and export UI.
- `drafts.ts` / `storage-session.ts`: validation and storage boundaries.
- `catalog-client.ts`: static manifest and locale reads.
- `community.ts` / `community-client.ts`: public contributions and account UI.
- `src/i18n/translation-community.ts`: shared DTOs and wording checks.
- `cloudflare/translation-community.ts`: public and protected review APIs.
- `scripts/apply-translation-suggestions.mts`: reviewed source-file application.
- `scripts/translation-catalog.ts`: literal source extraction.
- `scripts/translation-catalog-assets.ts`: build/dev asset generation.
- `dev/`: isolated preview and legacy read-only preview endpoint.

Existing workshop/tooling TypeScript and ESLint projects include these files.
Vitest covers drafts, export, storage conflicts, catalog packaging, navigation,
Worker routes, account/CSRF checks, recommendation and approval concurrency,
deletion cascades, literal application, and service-worker behavior. Local
community verification evidence is under `scratch/translation-community-2026-09-08/`.
