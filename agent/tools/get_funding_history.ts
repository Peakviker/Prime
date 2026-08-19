import { defineTool } from "eve/tools";
import { z } from "zod";

import { limited, num } from "#lib/hyperliquid.js";

const HOUR_MS = 3_600_000;

/**
 * Funding is the cost of carry on a perp, so its history is the raw
 * material for carry and basis strategies — and, read against open
 * interest, a positioning signal.
 */
export default defineTool({
  description:
    "Historical funding rates for one Hyperliquid perpetual. Funding is charged hourly; the response annualizes each rate so carry is comparable across coins.",
  inputSchema: z.object({
    coin: z.string().describe("Coin symbol, e.g. 'BTC'."),
    lookbackHours: z
      .number()
      .int()
      .positive()
      .max(24 * 90)
      .default(24 * 7)
      .describe("How many hours of funding history to return."),
    endTime: z
      .number()
      .int()
      .optional()
      .describe("End of the range, epoch ms. Defaults to now."),
  }),
  async execute({ coin, lookbackHours, endTime }) {
    const end = endTime ?? Date.now();
    const start = end - lookbackHours * HOUR_MS;

    const history = await limited(
      "fundingHistory",
      (client) =>
        client.fundingHistory({
          coin: coin.toUpperCase(),
          startTime: start,
          endTime: end,
        }),
      // Paginated info endpoints bill extra weight per 20 rows returned.
      Math.ceil(lookbackHours / 20),
    );

    const rates = history.map((entry) => num(entry.fundingRate));
    const mean =
      rates.length === 0
        ? 0
        : rates.reduce((sum, rate) => sum + rate, 0) / rates.length;

    return {
      coin: coin.toUpperCase(),
      count: history.length,
      meanHourlyRate: mean,
      meanAnnualizedPct: mean * 24 * 365 * 100,
      // Share of hours longs paid shorts — a quick read on directional
      // crowding before doing any real analysis.
      shareOfHoursPositive:
        rates.length === 0
          ? null
          : rates.filter((rate) => rate > 0).length / rates.length,
      columns: ["time", "fundingRate", "premium"],
      history: history.map((entry) => [
        entry.time,
        num(entry.fundingRate),
        num(entry.premium),
      ]),
    };
  },
});
