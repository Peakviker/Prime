import { defineTool } from "eve/tools";
import { z } from "zod";

import { ensureMigrated, db } from "#lib/db.js";

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Unlike funding (get_funding_history reads Hyperliquid's own historical
 * endpoint), open interest has no retroactive API — this table is the only
 * source for it, written every 5 minutes by the collect-funding schedule
 * for every listed market. Funding rate rides along in the same row so the
 * two can be read together without a second query.
 */
export default defineTool({
  description:
    "Open-interest and funding-rate history for one Hyperliquid perpetual, sampled every 5 minutes. Hyperliquid has no historical open-interest endpoint of its own, so this collected series is the only source for it. For funding rate alone, get_funding_history reaches further back using Hyperliquid's own history.",
  inputSchema: z.object({
    coin: z.string().describe("Coin symbol, e.g. 'BTC'."),
    since: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp. Defaults to 7 days ago."),
    limit: z
      .number()
      .int()
      .positive()
      .max(5000)
      .default(2000)
      .describe("Max rows to return, oldest first."),
  }),
  async execute({ coin, since, limit }) {
    await ensureMigrated();

    const sinceDate = since ? new Date(since) : new Date(Date.now() - DEFAULT_LOOKBACK_MS);
    if (Number.isNaN(sinceDate.getTime())) {
      throw new Error(`"${since}" is not a valid ISO 8601 timestamp.`);
    }

    const { rows } = await db().query<{
      funding_rate_hourly: number;
      open_interest_usd: number;
      mark_px: number;
      snapshot_at: Date;
    }>(
      `SELECT funding_rate_hourly, open_interest_usd, mark_px, snapshot_at
       FROM prime.funding_snapshots
       WHERE coin = $1 AND snapshot_at >= $2
       ORDER BY snapshot_at ASC
       LIMIT $3`,
      [coin.toUpperCase(), sinceDate, limit],
    );

    return {
      coin: coin.toUpperCase(),
      since: sinceDate.toISOString(),
      sampleCount: rows.length,
      columns: ["snapshotAt", "openInterestUsd", "fundingRateHourly", "markPx"],
      history: rows.map((row) => [
        row.snapshot_at.toISOString(),
        row.open_interest_usd,
        row.funding_rate_hourly,
        row.mark_px,
      ]),
    };
  },
});
