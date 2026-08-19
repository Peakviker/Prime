import { defineTool } from "eve/tools";
import { z } from "zod";

import { normalizeAddress } from "#lib/hyperliquid.js";
import {
  addWatchedAddress,
  deactivateWatchedAddress,
  listWatchedAddresses,
} from "#lib/watched-addresses.js";

/**
 * Manages the watched-address registry (docs/ARCHITECTURE.md WP3): who the
 * collection schedules snapshot on a cadence, and why. This is the only
 * write path into `prime.*` reachable from a conversation — the schedules
 * themselves only read the list, never decide what belongs on it.
 */
export default defineTool({
  description:
    "Add, remove, or list addresses on the watch list that the collection schedules snapshot on a cadence (positions over time — separate from the point-in-time reads the get_address_* tools return). Every addition needs a reason; that's what makes the registry legible later.",
  inputSchema: z.object({
    action: z.enum(["add", "remove", "list"]),
    address: z
      .string()
      .optional()
      .describe("Required for add/remove. 42-char hex, starts with 0x."),
    reason: z
      .string()
      .optional()
      .describe(
        "Required for add. Why this address is worth tracking over time.",
      ),
    label: z
      .string()
      .optional()
      .describe("Optional short human-readable name for add."),
  }),
  async execute({ action, address, reason, label }) {
    if (action === "list") {
      const addresses = await listWatchedAddresses({ activeOnly: false });
      return { addresses };
    }

    if (!address) {
      throw new Error(`"address" is required for action "${action}".`);
    }
    const user = normalizeAddress(address);

    if (action === "add") {
      if (!reason) {
        throw new Error('"reason" is required when adding an address.');
      }
      await addWatchedAddress(user, reason, label);
      return { address: user, active: true };
    }

    await deactivateWatchedAddress(user);
    return { address: user, active: false };
  },
});
