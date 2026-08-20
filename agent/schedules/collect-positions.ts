import { defineSchedule } from "eve/schedules";

import { db, ensureMigrated } from "#lib/db.js";
import { limited, normalizeAddress, num } from "#lib/hyperliquid.js";
import { currentSnapshotBucket } from "#lib/snapshot-time.js";
import { listWatchedAddresses } from "#lib/watched-addresses.js";

/**
 * Position snapshots (WP3): the one genuinely time-sensitive piece of data
 * here, per docs/ARCHITECTURE.md — Hyperliquid does not serve historical
 * position state, so a day this doesn't run is history nothing can recover
 * later.
 *
 * Deterministic code, no model in the loop by design: what gets collected
 * must not depend on what an LLM decided this run. `clearinghouseState`
 * costs 2 weight (see agent/lib/hyperliquid.ts), so this stays cheap even
 * against a watch list of dozens of addresses, and it shares the same
 * process-wide token bucket the interactive tools use.
 */
export default defineSchedule({
  cron: "*/5 * * * *",
  async run() {
    await ensureMigrated();
    const addresses = await listWatchedAddresses();
    if (addresses.length === 0) return;

    const snapshotAt = currentSnapshotBucket();

    for (const { address } of addresses) {
      const user = normalizeAddress(address);
      const state = await limited("clearinghouseState", (client) =>
        client.clearinghouseState({ user }),
      );
      const accountValue = num(state.marginSummary.accountValue);

      for (const { position } of state.assetPositions) {
        const size = num(position.szi);
        await db().query(
          `INSERT INTO prime.position_snapshots
             (address, coin, side, size, notional_usd, entry_px,
              unrealized_pnl_usd, leverage, account_value_usd, snapshot_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (address, coin, snapshot_at) DO NOTHING`,
          [
            user,
            position.coin,
            size > 0 ? "long" : "short",
            Math.abs(size),
            num(position.positionValue),
            position.entryPx === null ? null : num(position.entryPx),
            num(position.unrealizedPnl),
            position.leverage.value,
            accountValue,
            snapshotAt,
          ],
        );
      }
    }
  },
});
