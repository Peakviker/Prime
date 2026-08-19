/**
 * Both collection schedules fire every 5 minutes (see agent/schedules/) and
 * bucket their snapshot's timestamp to that same cadence, rather than using
 * the exact moment each row was written. That is what makes a sweep
 * idempotent: a retry (or a manual re-trigger) that lands in the same
 * 5-minute window computes the same `snapshot_at`, so the tables' UNIQUE
 * constraints turn the re-run into a no-op instead of a duplicate row — see
 * WP3's "re-running a sweep does not duplicate rows" acceptance criterion in
 * docs/ARCHITECTURE.md.
 */
export const SNAPSHOT_INTERVAL_MS = 5 * 60_000;

export function currentSnapshotBucket(): Date {
  return new Date(
    Math.floor(Date.now() / SNAPSHOT_INTERVAL_MS) * SNAPSHOT_INTERVAL_MS,
  );
}
