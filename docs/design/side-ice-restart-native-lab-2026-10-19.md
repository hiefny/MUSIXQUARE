# Side-PC ICE restart: release-2 native lab round

2026-10-19, owner go-ahead relayed by the main session: lab verification of the
side-PC ICE restart before a second release. No deployment, PR merge or release
workflow. Implementation and unit evidence:
[control-isolation-side-ice-restart-2026-10-19.md](control-isolation-side-ice-restart-2026-10-19.md).

## Branch update and repository gates

`claude/side-ice-restart-1eee23` merged current main `0ae3698d` (8.11.23/v732 in
production: #410 control isolation, delay-based receipt window, clock guard) as
merge `ee8dcd289e180050c249983baf73d23f7b611e1c` (tree
`519f64d42d9eaeb8ac0e33c3926181162e564c3b`). Main squash-merged #410, so the merge
was resolved by intent: files this branch never changed take main's version, and
the merged tree differs from main in exactly this branch's eight files with the
same added and removed lines as `db407305..a12c0f72`. Main's isolation module and
signaling owner equal the C9 blobs this branch started from, so the frozen C9
fixture also models the deployed 8.11.23 peer.

At `ee8dcd28` on Windows 11 with pinned Node 24.20.0 / npm 12.0.2 (worktree
`npm ci`): typecheck, lint and format:check pass; the full unit suite passes
**597 files / 13,422 tests, 0 failed, 0 skipped**
(JSON SHA256 `fe2d1d0b0c5cb1e19475e6f3aadec0870bacbcbf4edb1a57177f3eb4d68840cc`);
`build:checked` passes. Its cache guard passes only because it treats the merge,
which brought main's v732 bump into this branch, as the bump. The candidate runtime
still differs from production v732, so a release-2 integration must bump the App
and cache versions.

## Method

- Baseline: exact main `0ae3698d` e2e build, `http://127.0.0.1:4478`. Candidate:
  `ee8dcd28` e2e build, `http://127.0.0.1:4479`. Both from
  `infra/prepare-side-ice-restart-lab.py`, a port-only copy of the bundle preparer
  (served index/main/peer hashes verified). Local signaling Worker on 8870.
- Chromium 153.0.8010.12 headless, host and guest pages on one PC, real product
  negotiation, file input and buttons, the existing passive product observer and
  CDP shaping (guest P2P H8: 1 MB/s, 100 ms, from before navigation).
- Failure: guest-only P2P outage. The empty-pattern P2P rule of
  `Network.emulateNetworkConditionsByRule` gets `packetLoss: 100` while HTTP and
  WebSocket stay unrestricted, so signaling survives; restore re-applies H8.
  A pilot showed the per-rule `offline` flag does not affect P2P in this Chromium.
- Cases, order, gates and limits were fixed in the lab README before the frozen
  runs; every input (runner, analyzer, README, round scripts, imported QA modules,
  infra script, build manifests, fixtures) is hash-frozen per case. Pilots are kept
  separately and are not evidence.

| Case | Setup | Outage |
| --- | --- | --- |
| `idle` | one 4,800,044-byte ordinary file transferred and playing | 8 s; host pause at +1.5 s, play at +3.5 s |
| `mid-ordinary` | 23,040,044-byte ordinary transfer | 8 s once ≥7,000,000 payload bytes were sent |
| `mid-preload` | controlled YouTube playing, same file preloading | 8 s once ≥7,000,000 payload bytes were sent |
| `side-failed` ×2 | as `idle` | until either endpoint's side PC reports `failed` (cap 25 s) |

Candidate gates (baseline evaluated identically, for comparison only): G1 no
logical close (guest connection stays open, no disconnect dialog, no
`player:stop-all-media` cancellation, no host-side peer departure); G2 no new PC
and every original and side PC ends `connected`; G3 restart frames only on the
original control lane, at most two offers, epochs in order; G4 every non-bulk
application message from 2 s before the outage to 30 s after restore arrives once,
in order, both directions; G5 exact bytes/SHA for every completed file; G6 no page
errors. Validity: side route active on both endpoints before the outage, and for
`side-failed` a side PC actually reached `failed`.

## Result

**Candidate PASS in all five runs; the baseline closes the session in both
`side-failed` runs.** The frozen analyzer and a stricter re-analysis (below) agree
on all ten runs. Times are seconds from the outage start.

| Case | Arm | Verdict | Side PCs (guest / host) | Logical close | Controls delivered in order (host→guest, guest→host) | Transfer |
| --- | --- | --- | --- | --- | --- | --- |
| `idle` | candidate | PASS | disc. 6.3/6.4 → conn. 8.3 | none | 46/46, 40/40 | — |
| `idle` | baseline | (PASS) | disc. 6.3/6.4 → conn. 8.3 | none | 46/46, 40/40 | — |
| `mid-ordinary` | baseline | (PASS) | disc. 7.0/7.1 → conn. 8.2 | none | 44/44, 41/41 | complete, exact SHA (62.6 s) |
| `mid-ordinary` | candidate | PASS | disc. 7.2/7.4 → conn. 8.2/8.3 | none | 46/46, 41/41 | complete, exact SHA (64.9 s) |
| `mid-preload` | candidate | PASS | disc. 7.2/7.3 → conn. 8.2/8.3 | none | 60/60, 40/40 | aborted by host at 5.0 s |
| `mid-preload` | baseline | (PASS) | disc. 7.1/7.2 → conn. 8.3 | none | 58/58, 40/40 | aborted by host at 5.0 s |
| `side-failed` 1 | baseline | **FAIL** | failed 16.3/16.4 | **16.3, disconnect dialog, guest IDLE** | 2/4, 2/18 (pause, play and 16 pings lost) | — |
| `side-failed` 1 | candidate | PASS | failed 16.4 / disc. → conn. 16.9/16.8 | none | 58/58, 48/48 | — |
| `side-failed` 2 | candidate | PASS | failed 16.5 / disc. → conn. 17.0/16.8 | none | 56/56, 48/48 | — |
| `side-failed` 2 | baseline | **FAIL** | failed 16.3/16.5 | **16.4, disconnect dialog, guest IDLE** | 2/4, 2/18 | — |

What the runs show:

- With 100% loss, Chromium reported `disconnected` about 5–7.6 s in and the side
  PC `failed` about 16.3–16.6 s in. An 8 s outage therefore never reached
  `failed`: both arms recovered by ICE self-healing at about 8.3 s, so the short
  cases show no regression, not a difference.
- `side-failed` reproduces the #410 single point of failure in a real browser:
  the baseline closed at the side PC's `failed` (16.3/16.4 s), well before the
  original PC's own grace would have ended (about 22.3 s), stopped all media,
  showed `연결이 끊어졌어요`, and lost the pause/play pressed during the outage.
  The candidate kept the connection: its side PC reconnected right after restore
  (the old path still worked) and the restart already in flight completed
  (answer at 18.6/19.5 s). Every control, including the outage-time pause/play,
  arrived once and in order.
- Restart signaling stayed on the original control lane, one offer per run. In
  all five frozen candidate runs the host happened to be the side offerer (the
  guest sent `restart-request` then `restart-answer`); the guest-offerer path was
  exercised only in pilots, which are not evidence.
- Ordinary transfer: in both arms the guest's existing `request-data-recovery`
  and the host's `file-resume` (about 26 s in) completed the 23,040,044-byte file
  with exact bytes and SHA-256.
- Preload: in both arms the host aborted the preload at 5.0 s, when its original
  PC reported `disconnected`. `isBulkTransferWritablePeer` (`src/storage/chunk-pump.ts`)
  treats a disconnected original PC as unwritable, the broadcast preload pump then
  sends `PRELOAD_ABORT`, and `preload.ts` leaves recovery to the guest's
  AWAITING_PRELOAD watchdog. Nothing restarts it when the path recovers; YouTube
  playback continued. This matches the owner's 8.11.23 field note, predates #410
  and is unchanged by this branch: a separate follow-up, not a side-restart result.
- The host-presence loader `방장 응답 대기 중...` appeared about 5.4–5.7 s in and
  cleared at recovery in every surviving run. No page errors; observer drops and
  exceptions 0 on every page.

## Analysis integrity

The frozen `analyze.mjs`/`compare.mjs` verdict is primary
(`verdict-r1.json`, SHA256
`7852b645bc98b4456e5e10fce438771b1f0b864a0bb0b9972b374e81777b2fc2`). An
independent read-only review of the tooling, made while the runs executed and
before any result was inspected, found that the frozen analyzer could pass
vacuously (no proof a side PC was interrupted), counted a side failure after
restore as reached, matched controls by signature only (identical
`device-list-update` re-broadcasts), and required exact bytes before checking
integrity. A supplementary `analyze-v2.mjs`, written before inspection, fixes
these: side failure must precede restore, a side PC must leave `connected` before
restore, controls match by signature and occurrence, completion means ready for
the exact item, final PC states come from the end-of-run stats, and observer
drops must be zero. Its verdict (`verdict-v2-r1.json`, SHA256
`1c7ba2b940425a8cb115da0885536b7976bfe8d52185ee8755d6e42880233ee7`) agrees on all
ten runs. File A was hashed before the outage only.

## Evidence

Lab tooling, frozen cases and raw results are in this branch's worktree under
`scratch/side-ice-restart-lab-2026-10-19/` (ignored by git): `README.md`
(SHA256 `fea61852d7699fbfb60e18b0e56df64a706ecba527e2ee4936096e6cbe3a8f2f`),
`failure-runner.mts` (`124353b2c89762904bc3179a01ef02c28a2764d6008f15c7b8b578440514da2f`),
`analyze.mjs` (`88603ae4e2850a348e9773d618b20e0fef84ecc06a9a8517533f7cf3bcf7b8fd`),
`analyze-v2.mjs` (`17fc86bf6212bc92d935ed088d83e558b1d630843cb037b164cbd3959ec3730d`),
`cases-r1/plan.json` (`6e243db9c5035954cc057fa7bf51cfac98ab9b4e68e9a6f92751fb41dedf41d7`)
and `results/`. Builds are under the main checkout's
`scratch/control-isolation-product-2026-10-19/infra/runs/side-ice-restart-{baseline,candidate}-r1/`.

| Run | Raw SHA256 |
| --- | --- |
| idle candidate | `253b325cccf65226d0785329c6828148fc5dec0d4357889856b19f9d1e8e87c6` |
| idle baseline | `c00f1a826b34d7a3c4477da293285ad4cae45542d69cb2184c4842d1ea7f5706` |
| mid-ordinary baseline | `349bd5e902d34807467cb9a1a713d8c9b71278b782939ff9488bb9ed0eec67ee` |
| mid-ordinary candidate | `0da01a8eb250a64f46bae0d0bd081aebee7a929775436ed000ef479b775dccfb` |
| mid-preload candidate | `9cf4ad465bbbea7ac0ec9a7cc661ebffc120c41a91499f966e17c8dfde7c54d2` |
| mid-preload baseline | `874a41227d08076234a8603d113f8033224d692c9ef716dc0f0b2b7e634e9fc9` |
| side-failed baseline 1 | `4e92b56e07ce305de05c929d4ccfd3fb0fa67271f24b7edc1a7b47cb2bec988d` |
| side-failed candidate 1 | `e0fb21d601f18f1002f0adaedfbb3e810a98fb704e2f92b182fa68054cad1c48` |
| side-failed candidate 2 | `49fcd625f32de658f3ee2a13eb2a47cc3ef8b6d99a7230cf17eea3004052597f` |
| side-failed baseline 2 | `b120a9188eaca2014b3a284f91d33d8515a86cd99fab099ed664def2e25bff9a` |

## Limits

- Packet loss keeps both endpoints' addresses, so after restore the old path
  works again; this lab proves the candidate no longer closes on a side failure
  and that a restart completes, but not that new candidates find a new path.
- One run per arm per case (two for `side-failed`), one Windows PC, controlled
  YouTube provider, no TURN; ICE-TCP/TURN-TCP sockets bypass the CDP P2P rule but
  were not in use.

## Post-release real-device checks for release 2

Real networks and production TURN credentials are needed, so these run only after
a release-2 deployment, in this order (the first one fixed by the owner on
2026-10-19). Set `?mxqrLog=info` (or `localStorage['mxqr:logLevel']='info'`) on the
guest first, so the on-device console shows the side restart log lines.

1. **Wi-Fi to LTE after a direct file, host on Wi-Fi.** The host laptop stays on
   Wi-Fi. The guest phone joins on the same Wi-Fi, receives one direct file (the
   side route is then active), then switches from Wi-Fi to LTE. Owner field result
   on production 8.11.23 (2026-10-19): the connection ended with the disconnect
   dialog, confirming known-accepted #18. Release 2 passes when the guest sees no
   disconnect dialog or Reconnect, playback and controls continue, and the guest's
   console shows `Restarting isolated control ICE` followed by
   `Isolated control ICE recovered`.
2. **LTE to Wi-Fi for a remote guest without a direct file** (no side PC).
   Owner field result on 8.11.23: it recovered through the original PC's ICE
   restart, and the guest re-detected locality after `ice-recovered`. Recheck it
   as a regression.
3. **IP change on the same LAN** by switching the guest to a different SSID after
   a direct file.
4. iOS/Android WebKit and Chrome timing, background tabs, battery and audible sync.
