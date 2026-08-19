/**
 * Read-only Hyperliquid access.
 *
 * Everything here reads public data. No private key, no API wallet, no
 * signing — this agent cannot place, cancel, or modify an order, and adding
 * that capability would mean introducing `ExchangeClient`, which is
 * deliberately absent.
 *
 * The REST API allows an aggregate weight of 1200 per minute per IP, so
 * every call goes through a shared token bucket. Exceeding the budget is an
 * IP-level penalty affecting the whole deployment (including scheduled
 * collectors), which is why the limiter lives here rather than in each tool.
 */
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

/** Aggregate REST weight allowed per minute per IP. */
const WEIGHT_PER_MINUTE = 1200;

/**
 * Leave headroom so an interactive question never starves a scheduled
 * collector (or vice versa) at exactly the documented ceiling.
 */
const USABLE_WEIGHT_PER_MINUTE = WEIGHT_PER_MINUTE * 0.8;

const REFILL_PER_MS = USABLE_WEIGHT_PER_MINUTE / 60_000;

/**
 * Documented per-request weights. These six cost 2; every other documented
 * info request costs 20. Paginated responses add weight per page of results
 * (1 per 60 candles, 1 per 20 rows elsewhere), which `extraWeight` covers.
 */
const CHEAP_METHODS = new Set([
  "allMids",
  "clearinghouseState",
  "exchangeStatus",
  "l2Book",
  "orderStatus",
  "spotClearinghouseState",
]);

const CHEAP_WEIGHT = 2;
const DEFAULT_WEIGHT = 20;

class WeightLimiter {
  private available = USABLE_WEIGHT_PER_MINUTE;
  private lastRefill = Date.now();
  /** Serializes waiters so concurrent calls cannot each observe the same budget. */
  private queue: Promise<void> = Promise.resolve();

  private refill(): void {
    const now = Date.now();
    this.available = Math.min(
      USABLE_WEIGHT_PER_MINUTE,
      this.available + (now - this.lastRefill) * REFILL_PER_MS,
    );
    this.lastRefill = now;
  }

  /** Resolves once `weight` units are available, then spends them. */
  acquire(weight: number): Promise<void> {
    const spend = async (): Promise<void> => {
      // A single request can never cost more than the whole bucket, or it
      // would wait forever.
      const cost = Math.min(weight, USABLE_WEIGHT_PER_MINUTE);
      for (;;) {
        this.refill();
        if (this.available >= cost) {
          this.available -= cost;
          return;
        }
        const deficit = cost - this.available;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.ceil(deficit / REFILL_PER_MS)),
        );
      }
    };

    const next = this.queue.then(spend, spend);
    // Keep the chain alive even if a waiter rejects.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const limiter = new WeightLimiter();

const transport = new HttpTransport({
  timeout: 30_000,
  isTestnet: process.env.HYPERLIQUID_TESTNET === "1",
});

const info = new InfoClient({ transport });

/**
 * Runs one info request against the shared weight budget.
 *
 * `extraWeight` accounts for size-dependent surcharges on paginated
 * endpoints; pass the number of rows you expect to read back.
 */
export async function limited<T>(
  method: string,
  call: (client: InfoClient) => Promise<T>,
  extraWeight = 0,
): Promise<T> {
  const base = CHEAP_METHODS.has(method) ? CHEAP_WEIGHT : DEFAULT_WEIGHT;
  await limiter.acquire(base + extraWeight);
  return call(info);
}

export { info };

/** Hyperliquid returns every number as a string; parse at the boundary. */
export function num(value: string): number {
  return Number.parseFloat(value);
}

/**
 * Hyperliquid addresses are 42-char hex. The SDK validates this at runtime
 * and throws, so normalize and check here to fail with a message the model
 * can act on instead of a schema error.
 */
export function normalizeAddress(address: string): `0x${string}` {
  const trimmed = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(trimmed)) {
    throw new Error(
      `"${address}" is not a Hyperliquid address. Expected 42 hex characters starting with 0x.`,
    );
  }
  return trimmed as `0x${string}`;
}
