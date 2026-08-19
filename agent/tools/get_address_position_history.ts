import { defineTool } from "eve/tools";
import { z } from "zod";

import { ensureMigrated, db } from "#lib/db.js";
import { normalizeAddress } from "#lib/hyperliquid.js";

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hyperliquid does not serve historical position state (see
 * get_address_positions), so this is the only source for "what was this
 * address holding a week ago" — and only for addresses on the watch list,
 * from the point they were added. Backed by prime.position_snapshots,
 * written every 5 minutes by the collect-positions schedule.
 */
export default defineTool({
  description:
    "Position history for an address on the watch list (see watch_address), sampled every 5 minutes since it was added. Use this for questions about how a position evolved over time; use get_address_positions for the current state of any address, watched or not.",
  inputSchema: z.object({
    address: z
      .string()
      .describe("Hyperliquid account address (42-char hex, starts with 0x)."),
    coin: z
      .string()
      .optional()
      .describe("Filter to one coin, e.g. 'BTC'. Omit for all coins."),
    since: z
      .string()
      .optional()
      .describe("ISO 8601 timestamp. Defaults to 7 days ago."),
    limit: z
      .number()
      .int()
      .positive()
      .max(5000)
      .default(1000)
      .describe("Max rows to return, oldest first."),
  }),
  async execute({ address, coin, since, limit }) {
    const user = normalizeAddress(address);
    await ensureMigrated();

    const sinceDate = since ? new Date(since) : new Date(Date.now() - DEFAULT_LOOKBACK_MS);
    if (Number.isNaN(sinceDate.getTime())) {
      throw new Error(`"${since}" is not a valid ISO 8601 timestamp.`);
    }

    const { rows } = await db().query<{
      coin: string;
      side: string;
      size: number;
      notional_usd: number;
      entry_px: number | null;
      unrealized_pnl_usd: number;
      leverage: number;
      account_value_usd: number;
      snapshot_at: Date;
    }>(
      `SELECT coin, side, size, notional_usd, entry_px, unrealized_pnl_usd,
              leverage, account_value_usd, snapshot_at
       FROM prime.position_snapshots
       WHERE address = $1 AND snapshot_at >= $2
         AND ($3::text IS NULL OR coin = $3)
       ORDER BY snapshot_at ASC
       LIMIT $4`,
      [user, sinceDate, coin?.toUpperCase() ?? null, limit],
    );

    return {
      address: user,
      since: sinceDate.toISOString(),
      sampleCount: rows.length,
      columns: [
        "snapshotAt",
        "coin",
        "side",
        "size",
        "notionalUsd",
        "entryPx",
        "unrealizedPnlUsd",
        "leverage",
        "accountValueUsd",
      ],
      snapshots: rows.map((row) => [
        row.snapshot_at.toISOString(),
        row.coin,
        row.side,
        row.size,
        row.notional_usd,
        row.entry_px,
        row.unrealized_pnl_usd,
        row.leverage,
        row.account_value_usd,
      ]),
    };
  },
});
