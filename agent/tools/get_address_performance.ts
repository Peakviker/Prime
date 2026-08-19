import { defineTool } from "eve/tools";
import { z } from "zod";

import { limited, normalizeAddress, num } from "#lib/hyperliquid.js";

/**
 * Hyperliquid serves an account-value and PnL series per window, which is
 * what separates a trader with an edge from one who got a big position
 * right once. Judge candidates on this before spending effort on their
 * fills.
 */
export default defineTool({
  description:
    "Account value and PnL history for any Hyperliquid address, bucketed by window (day, week, month, all time). Use this first when assessing whether a trader is worth studying — it shows whether returns are persistent or a single lucky position.",
  inputSchema: z.object({
    address: z
      .string()
      .describe("Hyperliquid account address (42-char hex, starts with 0x)."),
  }),
  async execute({ address }) {
    const user = normalizeAddress(address);

    const portfolio = await limited("portfolio", (client) =>
      client.portfolio({ user }),
    );

    const windows = portfolio.map(([window, data]) => {
      const equity = data.accountValueHistory.map(([, value]) => num(value));
      const pnl = data.pnlHistory.map(([, value]) => num(value));

      const first = equity[0];
      const last = equity[equity.length - 1];

      // Max drawdown on the equity curve — the number that says whether a
      // return was survivable, which a headline PnL never does.
      let peak = Number.NEGATIVE_INFINITY;
      let maxDrawdown = 0;
      for (const value of equity) {
        peak = Math.max(peak, value);
        if (peak > 0) {
          maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
        }
      }

      return {
        window,
        samples: equity.length,
        startEquityUsd: first ?? null,
        endEquityUsd: last ?? null,
        pnlUsd: pnl.length ? pnl[pnl.length - 1]! - pnl[0]! : null,
        returnPct:
          first && first !== 0 && last !== undefined
            ? ((last - first) / first) * 100
            : null,
        maxDrawdownPct: equity.length ? maxDrawdown * 100 : null,
        tradedVolumeUsd: num(data.vlm),
      };
    });

    return {
      address: user,
      fetchedAt: new Date().toISOString(),
      windows,
    };
  },
});
