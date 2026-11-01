/**
 * The YouTube start ledger: which start owner holds the shared iframe now.
 *
 * Resource owner: RO-02
 *
 * Each start owner keeps its own state and registers live queries over it,
 * one claim per kind (registerYouTubeStartClaim, from player.ts, the start
 * owners' composition point). A derived query calls those queries when it is
 * asked and keeps nothing: no answer, flag, phase or snapshot, no
 * subscription and no event. The owner's state therefore has one machine,
 * its owner, and the ledger is the one place that composes the owners for
 * their readers (docs/design/youtube-start-ownership.md).
 *
 * The claim kinds, in the order every derived query asks them:
 * - 'standard-run': the zero-start run (zero-start.ts): in flight, protocol
 *   active, and hard-muted (muting, warming or settling);
 * - 'standard-recovery': the recovery that takes over a start the run gave up
 *   (player.ts): the guest local recovery, or on a host the legacy recovery,
 *   also after a peer replacement. Active while it owns the iframe's events;
 *   pending while active or, for the guest recovery, until its release is
 *   acknowledged;
 * - 'legacy-rendezvous': the legacy two-stage rendezvous's Stage-2 wait
 *   (player.ts);
 * - 'pro-arm': the coordinator-free PRO arm (authority-arm.ts, through its
 *   iframe.ts instance): hard-muted;
 * - 'pro-direct': the PRO direct COMMIT's local wait (player.ts).
 * A kind that no derived query reads yet registers nothing. Each derived
 * query decides every kind, with one of its queries or never (0): adding a
 * kind without its claim type, or without a decision in every derived query,
 * does not compile.
 */

/** A start owner's answer, read when a derived query is asked. */
type LiveQuery = () => boolean;

const START_CLAIM_KINDS = [
  'standard-run',
  'standard-recovery',
  'legacy-rendezvous',
  'pro-arm',
  'pro-direct',
] as const;

type YouTubeStartClaimKind = (typeof START_CLAIM_KINDS)[number];

/**
 * Each kind's live queries, by position: a property name would ship in the
 * eagerly loaded entry chunk.
 */
interface YouTubeStartClaims {
  'standard-run': readonly [inFlight: LiveQuery, protocolActive: LiveQuery, hardMuted: LiveQuery];
  'standard-recovery': readonly [active: LiveQuery, pending: LiveQuery];
  'legacy-rendezvous': readonly [stage2Pending: LiveQuery];
  'pro-arm': readonly [hardMuted: LiveQuery];
  'pro-direct': readonly [waiting: LiveQuery];
}

/**
 * A derived query's decisions: for each kind, in START_CLAIM_KINDS order, the
 * read of that kind's claim that decides it, or 0 for never.
 */
type Decisions<Kinds extends readonly YouTubeStartClaimKind[]> = {
  readonly [I in keyof Kinds]: Kinds[I] extends YouTubeStartClaimKind
    ? ((claim: YouTubeStartClaims[Kinds[I]]) => boolean) | 0
    : never;
};

type Decision = Decisions<typeof START_CLAIM_KINDS>;

const claims = new Map<YouTubeStartClaimKind, readonly LiveQuery[]>();

/**
 * Register a start owner's live queries for its kind; a later registration of
 * the same kind replaces it. Registering reads no query.
 */
export function registerYouTubeStartClaim<Kind extends YouTubeStartClaimKind>(
  kind: Kind,
  queries: YouTubeStartClaims[Kind],
): void {
  claims.set(kind, queries);
}

/**
 * Ask the kinds in order; the first claim that holds answers. A kind decided
 * never (0), or not registered, reads nothing.
 */
function holds(decision: Decision): boolean {
  return START_CLAIM_KINDS.some((kind, index) => {
    const decide = decision[index];
    const claim = claims.get(kind);
    return decide && claim && decide(claim as never);
  });
}

/**
 * Whether a start owner holds this speaker's start, so ordinary
 * synchronization must leave the iframe alone: the zero-start protocol is
 * active (through the timeline calibration after the release), or a recovery
 * still holds its claim (a failed prepare leaves the protocol in 'error', but
 * its bounded recovery can still own a muted, delayed release).
 * Decides the run by protocolActive and the recovery by pending; never the
 * legacy rendezvous, the PRO arm or the PRO direct wait.
 */
export function isYouTubeStartSyncOwned(): boolean {
  return holds([([, protocolActive]) => protocolActive(), ([, pending]) => pending(), 0, 0, 0]);
}

/**
 * Whether a start owner deliberately holds the iframe's hard mute, so an
 * ordinary volume or pause-gate change must not unmute it: a zero-start run
 * in muting, warming or settling, an active recovery, or the PRO arm.
 * Decides the run by hardMuted, the recovery by active and the PRO arm by
 * hardMuted; never the legacy rendezvous or the PRO direct wait.
 */
export function isYouTubeStartHardMuteOwned(): boolean {
  return holds([
    ([, , hardMuted]) => hardMuted(),
    ([active]) => active(),
    0,
    ([hardMuted]) => hardMuted(),
    0,
  ]);
}
