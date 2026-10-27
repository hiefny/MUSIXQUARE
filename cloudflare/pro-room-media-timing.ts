// The existing bounded fetch owners enforce these nested completion budgets.
// The binding fallback after a failed copy (RO-52) has no deadline of its own,
// as completion had through 9.0.15, so it can outlast the facade budget: after
// a timed-out copy only the 2 s difference remains. The same-key completion
// retry then replays the stored answer or re-verifies.
export const PRO_ROOM_MEDIA_COPY_TIMEOUT_MS = 8_000;
export const PRO_ROOM_MEDIA_COMPLETE_TIMEOUT_MS = PRO_ROOM_MEDIA_COPY_TIMEOUT_MS + 2_000;
