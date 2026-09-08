# App entry URLs and language

The shared app entry `/` retains its URL when its UI language changes. The
visible UI and `html[lang]` follow the saved preference or browser language,
including on first load and installed PWA launches. Changing language in the
app does not reload the document or discard a live session.

The root's canonical URL and Open Graph URL remain `https://musixquare.com/`.
Its build-materialized English metadata and root WebSite schema describe the
shared app entry; do not copy a locale document's head onto the root merely
because the user's UI language changed. `/index.html` follows the same runtime
ownership rule and retains the root canonical.

Explicit language entries such as `/ko/` and `/ja/` still select their own
language on direct visits, ahead of saved/browser preferences. Their static
HTML and metadata remain localized. Choosing another language from an explicit
entry changes its URL and head in place. `/en/` is the explicit English entry
with canonical `/`. These entries and their hreflang/sitemap declarations are
retained; this change does not consolidate the language URLs.

Room and login-return routes take priority over ordinary language selection.
After a successful Standard-room invite join, cleaning a numeric room path
returns to `/` while preserving the visible UI language and restoring root
metadata. Persistent PRO-room paths remain intact.

Regression checks cover root startup and selection, URL query/hash/history
continuity, explicit locale ownership, metadata recovery, PWA language
selection, and account return paths. Google rendering should be checked after
deployment, but neither a passing live test nor this routing contract guarantees
indexing, ranking, or a particular crawler language.
