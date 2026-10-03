// OFFLINE FALLBACK — not the validated model.
// The old web THRESHOLDS, kept only for the in-browser stand-in. Placeholders:
// online, the planning line is the result's `limit_core_c` and the near band is
// GET /settings `near_limit_margin_c` (both AT-owned, illustrative defaults).
export const STAND_IN_THRESHOLDS = {
  watchC: 38.5,
  alertC: 39.0,
  baselineC: 37.0,
} as const
