/**
 * The registry WP3 calls for: which addresses get snapshotted, and why each
 * was added. Deliberately separate from the collection schedules — they
 * only read this list, they never decide what belongs on it.
 */
import { db, ensureMigrated } from "./db.js";

export interface WatchedAddress {
  address: string;
  label: string | null;
  reason: string;
  active: boolean;
  addedAt: string;
}

export async function listWatchedAddresses(
  options: { activeOnly?: boolean } = {},
): Promise<WatchedAddress[]> {
  const { activeOnly = true } = options;
  await ensureMigrated();
  const { rows } = await db().query<{
    address: string;
    label: string | null;
    reason: string;
    active: boolean;
    added_at: Date;
  }>(
    `SELECT address, label, reason, active, added_at
     FROM prime.watched_addresses
     WHERE active OR NOT $1
     ORDER BY added_at`,
    [activeOnly],
  );
  return rows.map((row) => ({
    address: row.address,
    label: row.label,
    reason: row.reason,
    active: row.active,
    addedAt: row.added_at.toISOString(),
  }));
}

/** Adds a new address, or reactivates and updates the reason for an existing one. */
export async function addWatchedAddress(
  address: string,
  reason: string,
  label?: string,
): Promise<void> {
  await ensureMigrated();
  await db().query(
    `INSERT INTO prime.watched_addresses (address, reason, label)
     VALUES ($1, $2, $3)
     ON CONFLICT (address) DO UPDATE SET
       reason = EXCLUDED.reason,
       label = COALESCE(EXCLUDED.label, prime.watched_addresses.label),
       active = true`,
    [address, reason, label ?? null],
  );
}

/**
 * Soft-delete only. Past snapshots keep their foreign key, and re-watching
 * the same address later keeps its history intact.
 */
export async function deactivateWatchedAddress(address: string): Promise<void> {
  await ensureMigrated();
  await db().query(
    `UPDATE prime.watched_addresses SET active = false WHERE address = $1`,
    [address],
  );
}
