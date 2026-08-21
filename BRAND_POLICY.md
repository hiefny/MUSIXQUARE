# MUSIXQUARE Brand and Fork Identification Guide

This guide explains how to present an independent distribution, fork, or
hosted service based on MUSIXQUARE without making it appear official.

It applies equally to commercial and non-commercial projects. You do not need
permission merely to use, study, modify, distribute, host, support, or charge
for AGPL-licensed software under a distinct identity and in compliance with
the AGPL.

## 1. Use a Distinct Primary Identity

Choose your own product or service name and make it more prominent than any
reference to MUSIXQUARE.

Do not use a MUSIXQUARE Mark as your app name, service name, package name,
domain, account name, PWA identity, logo, favicon, or primary interface
branding without written permission.

A platform-generated fork name or historical repository path may remain where
it clearly identifies the repository as a fork rather than an official
distribution.

## 2. Identify the Project as Independent

To avoid confusion, a public service that identifies itself to users as based
on MUSIXQUARE should place a readily discoverable notice in its normal user
interface or About/Help area and in its source repository. Do not deliberately
hide the notice, disable the route containing it, or make it available only
through an undisclosed direct URL. This guidance does not restrict a factual
reference that applicable law permits without such a notice.

Recommended wording:

> [PROJECT] is an independent project based on MUSIXQUARE. It is not affiliated
> with, sponsored by, endorsed by, or operated by the MUSIXQUARE project or its
> Rights Holder, CHOI HYEONSEUNG.

Korean wording:

> [프로젝트]는 MUSIXQUARE를 기반으로 한 독립 프로젝트이며, MUSIXQUARE
> 프로젝트 또는 권리자 CHOI HYEONSEUNG과 제휴·후원·승인·운영 관계가
> 없습니다.

## 3. Replace Official Identity Surfaces

An independent public service should use its own accurate operator identity
and replace official MUSIXQUARE branding in user-facing surfaces, including as
applicable:

- page titles, headings, wordmarks, app names, manifests, icons, and favicons;
- canonical URLs, structured data, Open Graph, and social/search metadata;
- invite, QR, sitemap, API, signaling, share, and service URLs;
- terms, privacy notices, operator details, support contacts, and legal pages;
  and
- advertisements, store listings, screenshots, and promotional material.

Do not present `contact@musixquare.com`, `musixquare.com`, or official
MUSIXQUARE policies as the operator, contact, canonical identity, or policies
of an independent service.

## 4. Preserve License and Attribution

Rebranding does not permit removal of copyright, AGPL, modification,
additional-term, or third-party notices required by the applicable licenses.
Source history and legal references to MUSIXQUARE may remain even though the
public product identity must be distinct.

Truthful attribution to the upstream project is welcome. For example:

> Based on the open-source MUSIXQUARE project:
> https://github.com/hiefny/MUSIXQUARE

Attribution to the upstream project is not a substitute for the Corresponding
Source of a modified deployed version. Where AGPL section 13 applies, users
must receive a prominent opportunity to obtain the exact source corresponding
to the running version, including the material needed to build and install it.
That link must not point only to an older or unmodified upstream version.

## 5. Search and Promotional Presentation

A third-party project's own name should lead its page title, search result,
social preview, and advertisement. Any MUSIXQUARE reference should be factual
and subordinate.

Acceptable without separate permission:

> Aurora Audio — independent software based on MUSIXQUARE

Not acceptable without permission:

> MUSIXQUARE Pro

> Official MUSIXQUARE Cloud

> MUSIXQUARE — where the page actually operates an independently modified
> service

## 6. Public-Fork Checklist

Before publishing or operating a fork, verify that:

- [ ] the project has a distinct name, logo, icon, favicon, and domain;
- [ ] the PWA manifest and installed-app identity use that distinct brand;
- [ ] titles, canonical URLs, structured data, social cards, sitemaps, and
      search metadata accurately identify the independent service;
- [ ] QR, invite, API, signaling, share, and support links use the independent
      operator's domains;
- [ ] privacy, terms, contact, support, and operator information are accurate;
- [ ] if the service makes a user-facing MUSIXQUARE reference, a visible
      independence notice appears in the same context or a normal About/Help
      surface;
- [ ] copyright, license, modification, and third-party notices remain intact;
      and
- [ ] the exact Corresponding Source required by the AGPL is offered to users.

## No Quality or Commercial Approval Requirement

MUSIXQUARE does not review or control an independently branded fork merely
because it uses AGPL-licensed code. This guide imposes no quality gate,
non-commercial limitation, revenue share, registration requirement, or prior
approval requirement on a project that uses the MUSIXQUARE Marks only for
lawful attribution.

Trademark guidance is in [TRADEMARKS.md](./TRADEMARKS.md). Copyright
permissions remain governed by [LICENSE](./LICENSE). Additional terms apply
only where they are expressly incorporated as described in
[ADDITIONAL_TERMS.md](./ADDITIONAL_TERMS.md).
