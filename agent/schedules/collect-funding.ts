import { defineSchedule } from "eve/schedules";

import { db, ensureMigrated } from "#lib/db.js";
import { limited, num } from "#lib/hyperliquid.js";
import { currentSnapshotBucket } from "#lib/snapshot-time.js";

/**
 * Funding-rate and open-interest snapshots (WP3), market-wide rather than
 * per-address. One `metaAndAssetCtxs` call covers every coin (same call
 * get_market_state uses), so this stays a single request against the shared
 * token bucket regardless of how many markets Hyperliquid lists.
 *
 * Deterministic code, no model in the loop, matching collect-positions.ts.
 */
export default defineSchedule({
  cron: "*/5 * * * *",
  async run() {
    await ensureMigrated();
    const [meta, ctxs] = await limited("metaAndAssetCtxs", (client) =>
      client.metaAndAssetCtxs(),
    );
    const snapshotAt = currentSnapshotBucket();

    for (const [index, asset] of meta.universe.entries()) {
      const ctx = ctxs[index];
      if (!ctx || asset.isDelisted) continue;

      const markPx = num(ctx.markPx);
      await db().query(
        `INSERT INTO prime.funding_snapshots
           (coin, funding_rate_hourly, open_interest_usd, mark_px, snapshot_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (coin, snapshot_at) DO NOTHING`,
        [asset.name, num(ctx.funding), num(ctx.openInterest) * markPx, markPx, snapshotAt],
      );
    }
  },
});
