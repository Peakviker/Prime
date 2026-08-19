import { defineTool } from "eve/tools";
import { z } from "zod";

import { limited, normalizeAddress, num } from "#lib/hyperliquid.js";

const DAY_MS = 86_400_000;

/**
 * Fills are the only fully retroactive record of what an account actually
 * did, so participant research leans on this rather than on position
 * snapshots. Hyperliquid pages these 500 at a time up to 10k rows.
 */
export default defineTool({
  description:
    "Executed trades (fills) for any Hyperliquid address over a time range, including realized PnL and fees per fill. This history IS retroactive, unlike positions. Push the rows into the sandbox to compute win rate, holding time, or per-coin performance rather than judging by eye.",
  inputSchema: z.object({
    address: z
      .string()
      .describe("Hyperliquid account address (42-char hex, starts with 0x)."),
    lookbackDays: z
      .number()
      .int()
      .positive()
      .max(365)
      .default(30)
      .describe("How many days back to read fills from."),
    endTime: z
      .number()
      .int()
      .optional()
      .describe("End of the range, epoch ms. Defaults to now."),
    maxRows: z
      .number()
      .int()
      .positive()
      .max(2000)
      .default(500)
      .describe(
        "Cap on fills returned. Keep this modest — large results crowd out the conversation; aggregate in the sandbox instead.",
      ),
  }),
  async execute({ address, lookbackDays, endTime, maxRows }) {
    const user = normalizeAddress(address);
    const end = endTime ?? Date.now();
    const start = end - lookbackDays * DAY_MS;

    const fills = await limited(
      "userFillsByTime",
      (client) =>
        client.userFillsByTime({ user, startTime: start, endTime: end }),
      Math.ceil(maxRows / 20),
    );

    // Newest first, so truncation drops the oldest rather than the most
    // relevant fills.
    const ordered = [...fills].sort((a, b) => b.time - a.time);
    const rows = ordered.slice(0, maxRows);

    // Summarize over everything fetched, not just the returned page, so a
    // low maxRows does not silently skew the totals.
    let realizedPnl = 0;
    let fees = 0;
    let volume = 0;
    for (const fill of ordered) {
      realizedPnl += num(fill.closedPnl);
      fees += num(fill.fee);
      volume += num(fill.px) * num(fill.sz);
    }

    return {
      address: user,
      rangeStart: new Date(start).toISOString(),
      rangeEnd: new Date(end).toISOString(),
      totalFills: ordered.length,
      returnedFills: rows.length,
      truncated: ordered.length > rows.length,
      // Fees are netted out because gross PnL flatters high-turnover
      // accounts, which is exactly the population worth being sceptical of.
      realizedPnlUsd: realizedPnl,
      feesPaidUsd: fees,
      netPnlUsd: realizedPnl - fees,
      tradedVolumeUsd: volume,
      columns: [
        "time",
        "coin",
        "side",
        "price",
        "size",
        "closedPnl",
        "fee",
        "direction",
      ],
      fills: rows.map((fill) => [
        fill.time,
        fill.coin,
        fill.side === "B" ? "buy" : "sell",
        num(fill.px),
        num(fill.sz),
        num(fill.closedPnl),
        num(fill.fee),
        fill.dir,
      ]),
    };
  },
});
