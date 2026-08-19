import { defineTool } from "eve/tools";
import { z } from "zod";

import { limited, num } from "#lib/hyperliquid.js";

/** Hyperliquid caps a snapshot at 5000 candles regardless of the range asked for. */
const MAX_CANDLES = 5000;

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
  "1M": 2_592_000_000,
};

export default defineTool({
  description:
    "Historical OHLCV candles for one Hyperliquid perpetual. Returns at most 5000 candles per call — for a longer history, page backwards with endTime. Write the analysis itself in the sandbox rather than eyeballing the numbers here.",
  inputSchema: z.object({
    coin: z.string().describe("Coin symbol, e.g. 'BTC'."),
    interval: z
      .enum([
        "1m",
        "3m",
        "5m",
        "15m",
        "30m",
        "1h",
        "2h",
        "4h",
        "8h",
        "12h",
        "1d",
        "3d",
        "1w",
        "1M",
      ])
      .describe("Candle interval."),
    lookbackCount: z
      .number()
      .int()
      .positive()
      .max(MAX_CANDLES)
      .default(500)
      .describe("How many candles back from endTime to request."),
    endTime: z
      .number()
      .int()
      .optional()
      .describe("End of the range, epoch ms. Defaults to now."),
  }),
  async execute({ coin, interval, lookbackCount, endTime }) {
    const end = endTime ?? Date.now();
    const start = end - lookbackCount * INTERVAL_MS[interval]!;

    const candles = await limited(
      "candleSnapshot",
      (client) =>
        client.candleSnapshot({
          coin: coin.toUpperCase(),
          interval,
          startTime: start,
          endTime: end,
        }),
      // candleSnapshot bills extra weight per 60 candles returned.
      Math.ceil(lookbackCount / 60),
    );

    return {
      coin: coin.toUpperCase(),
      interval,
      count: candles.length,
      // Compact rows keep a 5000-candle response from dominating the
      // context window; the model can push these into the sandbox as-is.
      columns: ["openTime", "open", "high", "low", "close", "volume", "trades"],
      candles: candles.map((candle) => [
        candle.t,
        num(candle.o),
        num(candle.h),
        num(candle.l),
        num(candle.c),
        num(candle.v),
        candle.n,
      ]),
    };
  },
});
