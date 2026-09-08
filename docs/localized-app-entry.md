# App and About entry URLs and language

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

## About entries

The shared `/about` entry follows the same app preference as `/`: a supported
`musixquare-lang` value wins, while `system`, a missing value, or an unsupported
value falls back to the browser language and then English. A stale
`mxqr-landing-lang` value does not override the app preference on this shared
entry. Loading the page does not write or migrate stored preferences. Other
static pages retain their existing preference rules.

The visible About copy and `html[lang]` adapt while the URL, canonical, Open
Graph URL, and English search metadata stay on `/about`. The static asset is
English; existing translated About assets, canonical URLs, hreflang entries,
and sitemap entries remain intact. `/en/about` is a real English entry served
from that same asset with canonical `/about`; it must not redirect to the
adaptive entry. Other explicit About language paths continue to own their
display language and metadata ahead of stored and browser preferences.

The About language picker keeps its existing full-page navigation and
transition. English selection links to `/en/about`, and legacy `?lang=en`
About links redirect there too. Alias normalization retains other query
parameters and fragments. App help links select the displayed language's
explicit About entry. About's shared entry opens the shared app `/`, while
explicit About entries open their matching app-language entry. Editorial tabs
carry the displayed language so a visit through History, Blog, or Design does
not discard an explicit English choice.

About's initial reveal and page transition animations are unchanged. Regression
coverage includes preference conflicts, browser fallback, explicit English
GET/HEAD and aliases, query migration, metadata, app links, and actual picker
navigation.
