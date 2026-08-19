import { defineTool } from "eve/tools";
import { z } from "zod";

import { limited, num } from "#lib/hyperliquid.js";

/**
 * One `metaAndAssetCtxs` call covers price, funding, open interest and
 * volume for every perp, so screening questions ("where is funding most
 * negative?") cost a single request instead of one per coin.
 */
export default defineTool({
  description:
    "Current state of every Hyperliquid perpetual market: mark price, funding rate, open interest and 24h volume. Use this to screen markets — it returns all coins in one call. For a single coin's history use get_candles or get_funding_history.",
  inputSchema: z.object({
    coins: z
      .array(z.string())
      .optional()
      .describe(
        "Filter to these coins (e.g. ['BTC','ETH']). Omit to return every market.",
      ),
  }),
  async execute({ coins }) {
    const [meta, ctxs] = await limited("metaAndAssetCtxs", (client) =>
      client.metaAndAssetCtxs(),
    );

    const wanted = coins?.length
      ? new Set(coins.map((coin) => coin.toUpperCase()))
      : null;

    const markets = meta.universe
      .map((asset, index) => ({ asset, ctx: ctxs[index] }))
      .filter(({ asset, ctx }) => ctx && (!wanted || wanted.has(asset.name)))
      .map(({ asset, ctx }) => {
        // `ctx` is narrowed by the filter above.
        const context = ctx!;
        const markPx = num(context.markPx);
        return {
          coin: asset.name,
          markPx,
          oraclePx: num(context.oraclePx),
          // Funding is per-hour on Hyperliquid; annualize for comparison
          // against carry, which is how these are usually judged.
          fundingRateHourly: num(context.funding),
          fundingRateAnnualizedPct: num(context.funding) * 24 * 365 * 100,
          openInterestUsd: num(context.openInterest) * markPx,
          dayVolumeUsd: num(context.dayNtlVlm),
          premium: context.premium === null ? null : num(context.premium),
          maxLeverage: asset.maxLeverage,
          delisted: asset.isDelisted ?? false,
        };
      });

    return {
      fetchedAt: new Date().toISOString(),
      marketCount: markets.length,
      markets,
    };
  },
});
