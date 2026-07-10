# Type Safety Audit - 2026-05-30

> **Historical audit snapshot.** Escape-hatch counts, file positions, and test
> totals below describe the post-audit tree on 2026-05-30. They are evidence of
> that pass, not a live inventory; rerun the documented search for current data.

## Scope

Searched production TypeScript under `src/**/*.ts`, excluding `__tests__`, for:

```text
as any
as unknown as
@ts-ignore
@ts-expect-error
eslint-disable
```

The initial scan found broad escape hatches across app globals, platform/browser API probes, state mutation internals, debug commands, network connection bookkeeping, DOM View Transitions, PeerJS dynamic import boundaries, and one BlobPart typing mismatch.

After this pass, the production scan has one remaining `as unknown as` holdout:

```text
src/storage/ramstore.ts:189
```

That holdout is kept because TypeScript's `BlobPart` generic rejects `Uint8Array<ArrayBufferLike>` in this build, while the `Blob` constructor accepts `ArrayBufferView` at runtime. The nearby comment documents the mismatch.

## Audit Table

Line numbers below refer to the original pre-change scan.

| File | Original line(s) | Original escape | Action |
| --- | ---: | --- | --- |
| `src/app.ts` | 507 | window debug hook cast | Replaced with `Window.__MXQR` declaration. |
| `src/core/events.ts` | 46 | wrapper `_originalFn` cast | Replaced function property mutation with a `WeakMap`. |
| `src/core/events.ts` | 63 | listener `_originalFn` cast | Replaced lookup with the same `WeakMap`. |
| `src/core/platform.ts` | 12 | `window.MSStream` cast | Replaced with a local `WindowWithLegacyMsStream` structural type and guarded window access. |
| `src/core/platform.ts` | 13 | `navigator.userAgentData` cast | Replaced with local `NavigatorWithInstallHints`. |
| `src/core/platform.ts` | 49 | `navigator.standalone` cast | Replaced with local `NavigatorWithInstallHints`. |
| `src/core/log.ts` | 72 | `globalThis.setLogLevel` cast | Replaced with a typed global declaration. |
| `src/chat/profanity.ts` | 20 | content-shield Korean shape cast | Replaced with readonly dictionary interfaces. |
| `src/chat/profanity.ts` | 31 | content-shield English shape cast | Replaced with readonly dictionary interfaces. |
| `src/core/state.ts` | 244 | `eslint-disable no-console` | Replaced dev console call with `log.debug`. |
| `src/core/state.ts` | 260 | `_state` mutable record cast | Replaced with a named `asMutableStateRecord` helper. |
| `src/core/state.ts` | 266 | `eslint-disable no-console` | Replaced dev console call with `log.warn`. |
| `src/core/state.ts` | 303 | `_state` mutable record cast | Replaced with `asMutableStateRecord`. |
| `src/core/state.ts` | 309 | `eslint-disable no-console` | Replaced dev console call with `log.warn`. |
| `src/core/state.ts` | 394-396 | E2E window hook casts | Replaced with typed `Window` hook declarations. |
| `src/chat/commands.ts` | 492 | `navigator.standalone` cast | Replaced with typed debug navigator helper. |
| `src/chat/commands.ts` | 566 | playlist item record cast | Replaced with typed `PlaylistItem` access. |
| `src/chat/commands.ts` | 576 | `performance.memory` cast | Replaced with typed `PerformanceWithMemory`. |
| `src/chat/commands.ts` | 589 | `navigator.connection` cast | Replaced with typed debug navigator helper. |
| `src/chat/commands.ts` | 962 | `navigator.standalone` cast | Replaced with typed debug navigator helper. |
| `src/chat/commands.ts` | 1049 | `performance.memory` cast | Replaced with typed `PerformanceWithMemory`. |
| `src/chat/commands.ts` | 1168 | `BlobURLManager` private-state record cast | Replaced with direct typed object-property access. |
| `src/chat/commands.ts` | 1190 | playlist array shape cast | Replaced with typed state access. |
| `src/chat/commands.ts` | 1703 | command metadata cast | Replaced with `CommandDef.hideFromSuggest`. |
| `src/youtube/iframe.ts` | 319 | `window.YT` cast | Replaced with typed `Window.YT` declaration. |
| `src/share/r2-client.ts` | 74 | remote-share endpoint global cast | Replaced with typed `Window.__MUSIXQUARE_REMOTE_SHARE_ENDPOINT__`. |
| `src/types/index.ts` | 196 | `eslint-disable no-empty-object-type` | Replaced `type NoPayload = {}` with `Record<never, never>`. |
| `src/player/decode.ts` | 99 | `eslint-disable no-restricted-globals` | Replaced raw `setTimeout` call with `globalThis.setTimeout`. |
| `src/player/decode.ts` | 836 | playlist recovery-name cast | Replaced with typed `PlaylistItem` access. |
| `src/network/guest.ts` | 225 | mutating PeerJS conn `_errorHandled` | Replaced with `WeakSet<DataConnection>`. |
| `src/network/guest.ts` | 236 | reading conn `_errorHandled` | Replaced with `WeakSet<DataConnection>`. |
| `src/network/guest.ts` | 242 | writing conn `_errorHandled` | Replaced with `WeakSet<DataConnection>`. |
| `src/network/guest.ts` | 258 | reading conn `_errorHandled` | Replaced with `WeakSet<DataConnection>`. |
| `src/network/guest.ts` | 259 | writing conn `_errorHandled` | Replaced with `WeakSet<DataConnection>`. |
| `src/network/guest.ts` | 375 | device-list `connectionType` cast | Added optional `connectionType` to `DeviceInfo` and used typed access. |
| `src/player/ownership.ts` | 616 | projected app-state window hook cast | Replaced with typed `Window.__MUSIXQUARE_GET_PROJECTED_APP_STATE__`. |
| `src/storage/ramstore.ts` | 189 | `Uint8Array` to `BlobPart` bridge | Kept with local comment; unavoidable DOM lib generic mismatch. |
| `src/player/playback.ts` | 876 | playlist item cast | Replaced with typed `PlaylistItem` access. |
| `src/player/playback.ts` | 924 | playlist item cast | Replaced with typed `PlaylistItem` access. |
| `src/player/transport.ts` | 224 | `AudioBufferSourceNode.buffer` cast | Replaced with direct `node.buffer = null`. |
| `src/ui/settings.ts` | 781 | device list render cast | Replaced with `DeviceListRow` interface and guard for unknown arrays. |
| `src/ui/dom.ts` | 28 | `document.startViewTransition` cast | Replaced with local `DocumentWithViewTransition`. |
| `src/ui/dom.ts` | 59 | ViewTransition call/result cast | Replaced with typed `ViewTransitionLike`. |
| `src/network/transport/peerjs-adapter.ts` | 21 | PeerJS dynamic import module cast | Replaced with a typed constructor extraction from the imported module. |

## Verification

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test` passed: 67 files, 974 tests.

## Remaining Holdout

`src/storage/ramstore.ts:189` still uses `as unknown as BlobPart`. This is intentionally isolated at Blob finalization, not in the per-chunk receive path. Replacing it with a copy into a narrower `ArrayBuffer` would add avoidable allocation during finalize, so the current cast is the lower-risk option.
