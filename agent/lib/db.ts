/**
 * Postgres access for Prime's own data (watched addresses, position and
 * funding snapshots) — separate from the Workflow world's tables, which
 * live in their own `workflow` schema on the same instance ("Postgres on
 * the VM ... serves double duty", see docs/ARCHITECTURE.md WP3). Everything
 * here lives under the `prime` schema so the two never collide.
 */
import { Pool } from "pg";

const pool = new Pool({
  // Same instance the Workflow world uses (WORKFLOW_POSTGRES_URL); DATABASE_URL
  // is accepted as a fallback for anyone wiring a distinct connection string.
  connectionString:
    process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL,
});

export function db(): Pool {
  return pool;
}

const SCHEMA = `
  CREATE SCHEMA IF NOT EXISTS prime;

  CREATE TABLE IF NOT EXISTS prime.watched_addresses (
    address TEXT PRIMARY KEY,
    label TEXT,
    reason TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS prime.position_snapshots (
    id BIGSERIAL PRIMARY KEY,
    address TEXT NOT NULL REFERENCES prime.watched_addresses (address),
    coin TEXT NOT NULL,
    side TEXT NOT NULL,
    size DOUBLE PRECISION NOT NULL,
    notional_usd DOUBLE PRECISION NOT NULL,
    entry_px DOUBLE PRECISION,
    unrealized_pnl_usd DOUBLE PRECISION NOT NULL,
    leverage DOUBLE PRECISION NOT NULL,
    account_value_usd DOUBLE PRECISION NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL,
    UNIQUE (address, coin, snapshot_at)
  );

  CREATE INDEX IF NOT EXISTS position_snapshots_address_idx
    ON prime.position_snapshots (address, snapshot_at DESC);

  CREATE TABLE IF NOT EXISTS prime.funding_snapshots (
    id BIGSERIAL PRIMARY KEY,
    coin TEXT NOT NULL,
    funding_rate_hourly DOUBLE PRECISION NOT NULL,
    open_interest_usd DOUBLE PRECISION NOT NULL,
    mark_px DOUBLE PRECISION NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL,
    UNIQUE (coin, snapshot_at)
  );

  CREATE INDEX IF NOT EXISTS funding_snapshots_coin_idx
    ON prime.funding_snapshots (coin, snapshot_at DESC);
`;

let migrated: Promise<void> | undefined;

/**
 * Idempotent `CREATE ... IF NOT EXISTS`, cached per process. Every entry
 * point that touches `prime.*` awaits this first — there is no separate
 * bootstrap step to remember, unlike the Workflow world's schema (see
 * deploy/README.md).
 */
export function ensureMigrated(): Promise<void> {
  migrated ??= pool.query(SCHEMA).then(() => undefined);
  return migrated;
}
