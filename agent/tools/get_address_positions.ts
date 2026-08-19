import { defineTool } from "eve/tools";
import { z } from "zod";

import { limited, normalizeAddress, num } from "#lib/hyperliquid.js";

/**
 * Every Hyperliquid account's perp state is public, which is what makes
 * participant research possible here at all. Note this is a point-in-time
 * read: positions are not retrievable retroactively, so the historical
 * series comes from the snapshot schedule, not from this tool.
 */
export default defineTool({
  description:
    "Current perpetual positions and margin state for any Hyperliquid address. This is a snapshot of right now — Hyperliquid does not serve historical position state, so past positions come from collected snapshots instead. For realized trading history use get_address_fills.",
  inputSchema: z.object({
    address: z
      .string()
      .describe("Hyperliquid account address (42-char hex, starts with 0x)."),
  }),
  async execute({ address }) {
    const user = normalizeAddress(address);

    const state = await limited("clearinghouseState", (client) =>
      client.clearinghouseState({ user }),
    );

    const accountValue = num(state.marginSummary.accountValue);

    const positions = state.assetPositions.map(({ position }) => {
      const size = num(position.szi);
      const notional = num(position.positionValue);
      return {
        coin: position.coin,
        side: size > 0 ? ("long" as const) : ("short" as const),
        size: Math.abs(size),
        notionalUsd: notional,
        entryPx: position.entryPx === null ? null : num(position.entryPx),
        liquidationPx:
          position.liquidationPx === null ? null : num(position.liquidationPx),
        unrealizedPnlUsd: num(position.unrealizedPnl),
        returnOnEquity: num(position.returnOnEquity),
        leverage: position.leverage.value,
        marginMode: position.leverage.type,
        // Funding paid since the position opened — separates carry cost
        // from directional PnL when judging how a trade actually did.
        cumulativeFundingSincePositionUsd: num(
          position.cumFunding.sinceOpen,
        ),
        // Share of the account riding on this one position.
        shareOfAccountValue:
          accountValue === 0 ? null : notional / accountValue,
      };
    });

    return {
      address: user,
      fetchedAt: new Date().toISOString(),
      accountValueUsd: accountValue,
      withdrawableUsd: num(state.withdrawable),
      totalNotionalUsd: num(state.marginSummary.totalNtlPos),
      totalMarginUsedUsd: num(state.marginSummary.totalMarginUsed),
      // Gross leverage: how much exposure this account carries per dollar
      // of equity. The single most comparable risk number across traders.
      grossLeverage:
        accountValue === 0
          ? null
          : num(state.marginSummary.totalNtlPos) / accountValue,
      openPositionCount: positions.length,
      positions,
    };
  },
});
