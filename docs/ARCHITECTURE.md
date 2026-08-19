# Prime — infrastructure plan

Canonical spec for implementing Prime, a read-only research agent for the
Hyperliquid perpetuals market. Written for the agents and engineers who will
build it. Decisions in the "Locked decisions" table were made deliberately —
treat them as settled unless the operator reopens one.

## What Prime is

A research partner, not a trading bot. It reads public Hyperliquid data to
find and stress-test strategy ideas, study other market participants, build
reports and charts, and argue about results with one operator.

It has **no ability to trade**, by construction: no private key, no API
wallet, no `ExchangeClient` import anywhere in the tree. Everything it touches
is public data, so a total compromise of the system costs no money. Any change
that introduces order placement invalidates most of the security reasoning
below and needs its own design pass.

## Target architecture

Two tiers, split at the runtime boundary.

| | Vercel | Google Compute Engine VM |
|---|---|---|
| Role | Control panel | Everything else |
| Runs | Next.js: dashboards, web chat UI, admin | eve runtime (`eve build && eve start`) |
| Also | — | Postgres (market data + agent memory), Docker sandbox, Nitro cron, Telegram webhook |
| Talks to | The VM, through its own API routes | Hyperliquid public API, AI Gateway |

The browser never calls the VM directly. Vercel's API routes proxy it, which
keeps credentials server-side and avoids CORS entirely.

`defineRemoteAgent` is **not** part of this design. That primitive is for two
eve deployments delegating to each other; here there is one runtime and one
UI, which is an ordinary client-server call.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Trading capability | Read-only, permanently | Everything needed is public data. No key means no blast radius. |
| Runtime location | The VM, not Vercel | Vercel's sandbox sleeps after 30 min and may lose `/workspace` on replacement; Docker on the VM keeps a long-lived container per session. Research needs cached datasets and long backtests. |
| Storage | Postgres on the VM | Serves double duty: market data plus the Workflow world that backs durable session state ("agent memory"). |
| Hyperliquid client | `@nktkas/hyperliquid` `InfoClient` | Typed and valibot-validated request/response schemas. Writing shapes by hand would be unverifiable guesswork. |
| Rate limiting | One process-wide token bucket | The 1200 weight/min budget is per-IP and shared between chat and scheduled collectors. A per-tool limiter cannot see the whole budget. |
| Model | `anthropic/claude-opus-5` | Reasoning-heavy work that writes its own analysis code, plus inbound chart images. The scaffold default takes no image input at all. |
| Backtest engine | Authored harness in `lib/`; the model writes only the signal function | Prevents lookahead, fee and funding omission by construction rather than by instruction. See WP5. |
| Channels | Telegram and web chat | Both point at the same runtime. |

## Work packages

Numbered by dependency order — WP2 unblocks everything after it.

### WP1 — Hyperliquid read layer

**Status: reference implementation exists** on branch
`claude/hyperliquid-phase1-reference`. It typechecks but has never run
against the live API, because the authoring sandbox's network policy blocked
`api.hyperliquid.xyz`. First job is to verify it, not to rewrite it.

Files: `agent/lib/hyperliquid.ts`, `agent/tools/get_*.ts`,
`agent/instructions.md`, `agent/channels/telegram.ts`, `agent/agent.ts`.

Six tools: market state across all perps in one call, candles, funding
history, and per-address positions, fills and performance. Each returns
compact columnar rows plus pre-computed summary statistics, so screening
questions do not burn context re-deriving means and drawdowns.

Acceptance:
- Every tool returns real data against mainnet.
- Sustained polling does not trip a 429 from Hyperliquid.
- A Telegram message reaches the agent and gets a reply.

### WP2 — VM runtime bring-up

Move the runtime off Vercel. Nothing in WP1 changes; only four things are
platform-specific.

1. **Workflow world.** Replace the default local world with a Postgres-backed
   one via `experimental.workflow.world` in `agent/agent.ts`. Pin it to the
   same `@workflow/*` line as the installed eve (currently `5.0.0-beta`).
   **Done:** `agent/agent.ts` sets it to `@workflow/world-postgres@5.0.0-beta.34`
   — its own `@workflow/{errors,utils,world,world-local}` sub-dependencies
   match eve's exactly, confirming the pin. Connection string via
   `WORKFLOW_POSTGRES_URL`; `docker-compose.yml` provisions the Postgres
   instance.
2. **Sandbox backend.** Docker. Never `vercel()` — that would create hosted
   sandboxes from the VM. **Done:** `agent/sandbox.ts` pins `docker()`
   explicitly rather than relying on `defaultBackend()`'s fallback order.
3. **Route auth.** `vercelOidc()` authenticates nothing off Vercel. The
   `httpBasic()` fallback already in `agent/channels/eve.ts` covers the gap;
   replace it with JWT or OIDC before the web chat carries real users.
4. **Model access.** Set `AI_GATEWAY_API_KEY` — OIDC no longer applies.
   **Done:** set in `/opt/prime/.env` on the VM, `prime.service` restarted,
   health answers `{"ok":true,"status":"ready"}`.

Reverse proxy must forward **both** `/eve/` and `/.well-known/workflow/`,
with TLS and a public hostname (Telegram's webhook lands here).
`deploy/Caddyfile` covers this: a bare `reverse_proxy` with no path
matchers, so there's no per-path config to get wrong the way a scoped nginx
`location /eve/ { ... }` block could omit the workflow prefix. `prime.service`
now binds `eve start` to `127.0.0.1` instead of `0.0.0.0` accordingly —
Caddy becomes the only public entry point. See `deploy/README.md` for
install and the DNS prerequisite (an A record for the hostname, pointing at
the VM, that Caddy's ACME challenge needs).

**Done, applied on the VM:** `vm.gameseller.digital` → the VM's public IP,
Caddy installed, `deploy/Caddyfile` in place, Let's Encrypt cert issued
(valid to 2026-11-17, auto-renew), `prime.service` updated to
`--host 127.0.0.1` and restarted. `GET https://vm.gameseller.digital/eve/v1/health`
answers `HTTP/2 200` over TLS 1.3; port 3000 is no longer reachable from
outside the VM.

The GCP firewall rule for 80/443 initially didn't apply — it was scoped to
`target-tags: backeve`, but the VM itself carried no network tags, so
nothing matched. Fixed with `gcloud compute firewall-rules update
allow-http-https --no-target-tags`. Separately, `prime.service` needed
re-copying to `/etc/systemd/system/` before the `--host 127.0.0.1` change
took effect — the first restart after editing the repo's copy was still
running the old `--host 0.0.0.0` unit.

**Process supervision.** `deploy/prime.service` (systemd, `Restart=always`)
plus the Postgres world above are both required for "doesn't crash": the
unit alone restarts a dead process but loses in-flight sessions to the
default in-memory world; the Postgres world alone doesn't restart anything
by itself. See `deploy/README.md` for setup and `deploy/deploy.sh` for the
build-and-restart step.

**Run on the target VM (backeve):** Docker installed, dedicated `prime`
system user (in the `docker` group), Postgres up via compose, `prime.service`
enabled and active, superseding the ad-hoc `eve-app.service` an earlier
manual deploy had left running in-memory. `GET /eve/v1/health` answers within
5s of a restart. Two gaps surfaced during this run and are now fixed here:
`pnpm-workspace.yaml` needed explicit `allowBuilds: false` entries for three
transitive native packages (`@mongodb-js/zstd`, `cbor-extract`,
`node-liblzma`) or a non-interactive `pnpm install --frozen-lockfile` fails;
and the Postgres schema doesn't create itself — `deploy/README.md` now
documents running `npx --package=@workflow/world-postgres bootstrap` once
before first start.

Acceptance — **all three done, verified on the VM:**
- `GET /eve/v1/health` answers — now over TLS through Caddy at
  `https://vm.gameseller.digital/eve/v1/health` (see above), not just
  direct on port 3000.
- A real turn completes — sent a live message (temporarily on `zai/glm-5.2`,
  a free week Vercel granted; `agent/agent.ts` was restored to
  `anthropic/claude-opus-5` afterward, git diff clean).
- **A session survives a mid-flight restart**, not just the process: run
  `wrun_01M0CQ007FHHBRVEQT01MAMQ36` started `09:52:45`; `systemctl restart
  prime` fired `09:52:46`, ~0.3s in, mid-generation. Startup log:
  `[world-postgres] Re-enqueued 4 active run(s) on startup`. The same run's
  `turnWorkflow` restarted `09:52:50` and completed `09:53:02` — the model
  finished the same response under the same `sessionId`, nothing lost.
  Health stayed `active`/`enabled` throughout.

This closes all of WP2's acceptance criteria, including the reverse
proxy/TLS piece. Open: swapping the `httpBasic()` stopgap (temporary
`ROUTE_AUTH_BASIC_USERNAME`/`PASSWORD` on the VM) for JWT/OIDC before real
users reach this over the web (item 3 above) — deliberately deferred until
there's an actual public-facing chat to protect.

### WP3 — Collection and storage

The only genuinely time-sensitive package. Position snapshots are **not**
retroactive: every day this is not running is history that cannot be
recovered later. Candles, funding and fills can all be backfilled.

Schedules under `agent/schedules/`, writing to Postgres. Deterministic code,
no model in the loop — collection must not depend on what an LLM decided this
run.

Tables, at minimum: position snapshots per watched address over time; funding
and open interest per coin; a registry of watched addresses with why each was
added.

Budget the collectors against the same token bucket as interactive use.
`clearinghouseState` costs 2 weight, so ~50 addresses per sweep is cheap;
paginated endpoints cost 20 plus a surcharge per page and need more care.

**Status: implemented, not yet verified against live traffic.** Same
constraint as WP1 — the authoring sandbox's network policy blocks
`api.hyperliquid.xyz` and the AI Gateway catalog (`eve info`/`eve build`
fail here with a 403), so this typechecks but has not run end to end. First
job on the VM is to verify it, not to rewrite it.

- `agent/lib/db.ts` — the three tables (`prime.watched_addresses`,
  `prime.position_snapshots`, `prime.funding_snapshots`) live in a `prime`
  schema on the **same** Postgres instance and database the Workflow world
  uses (`WORKFLOW_POSTGRES_URL`), just a different schema, so it doesn't
  collide with the world's own tables. Self-migrating (`ensureMigrated()`,
  idempotent `CREATE ... IF NOT EXISTS`) — unlike the Workflow world, there
  is no separate bootstrap command to run first.
- `agent/lib/watched-addresses.ts` — the registry. `agent/tools/watch_address.ts`
  is the only write path into it: add/remove/list, and `reason` is required
  on add, which is what makes "why each was added" durable rather than
  tribal knowledge.
- `agent/schedules/collect-positions.ts` and `agent/schedules/collect-funding.ts`
  — both `cron: "*/5 * * * *"`, both plain `run()` handlers with no agent
  session and no model call. `collect-positions` walks the watch list through
  `clearinghouseState` (2 weight each); `collect-funding` is one
  `metaAndAssetCtxs` call (20 weight) covering every listed market, same as
  `get_market_state`. Both go through the same `limited()` token bucket as
  interactive tool calls (`agent/lib/hyperliquid.ts`).
- **Idempotency.** `agent/lib/snapshot-time.ts` buckets each sweep's
  `snapshot_at` to the same 5-minute cadence the schedules fire on
  (`Math.floor(Date.now() / 300_000) * 300_000`), instead of the exact
  moment each row is written. A retry or manual re-trigger landing in the
  same window computes the same `snapshot_at`, so the tables' `UNIQUE
  (address, coin, snapshot_at)` / `UNIQUE (coin, snapshot_at)` constraints
  plus `ON CONFLICT DO NOTHING` turn it into a no-op.
- `agent/tools/get_address_position_history.ts` and
  `agent/tools/get_open_interest_history.ts` — read paths over the two
  snapshot tables, so the collected data is answerable from chat before WP6's
  dashboards exist. Open interest has no retroactive Hyperliquid endpoint at
  all, unlike funding (`get_funding_history` reads Hyperliquid's own history
  and reaches further back) — these tables are the only source for it.

Acceptance:
- A sweep runs on its cron cadence and writes rows. **Not yet verified** —
  needs live Hyperliquid access; verify on the VM via the dev dispatch route
  or a production tick, per `deploy/README.md`.
- Interactive questions stay responsive while a sweep is running.
  Architecturally true (`limited()` is a promise-queued in-memory limiter,
  not a blocking call, so a sweep's requests interleave with interactive
  ones on the same budget instead of locking it out), but not yet observed
  under real concurrent load.
- Re-running a sweep does not duplicate rows. **Verified by construction**
  (see idempotency above) but not yet exercised against a live Postgres —
  this sandbox has no Docker daemon to bring up `docker-compose.yml`'s
  `postgres` service either.

### WP4 — Sandbox analysis stack

Install Python with pandas, numpy, duckdb, pyarrow, matplotlib and scipy in
sandbox `bootstrap()` so analysis needs no network at session time. Keep
`/workspace` as the working surface for cached extracts.

This is what lets the agent answer questions nobody pre-built a tool for: it
writes the analysis rather than picking from a fixed menu. Deliberately **not**
a library of pre-built metric tools.

Then charts: Telegram's default delivery is plain text, so rendering PNGs
needs a custom `message.completed` handler using `channel.telegram`.

Acceptance:
- The agent computes a non-trivial statistic end to end from a question.
- A chart arrives in Telegram as an image.
- Analysis works with sandbox egress disabled.

### WP5 — Backtest harness

The package where quality is won or lost. A model writing a fresh backtest
per idea will produce results that are systematically too good: lookahead,
missing fees, funding ignored, best-of-many-variants reported, fit and
evaluation on the same window.

So the harness is authored code in `lib/` and owns all accounting:
next-bar execution, taker and maker fees, slippage, funding charged over the
holding period, and a held-out evaluation window. The model supplies **only**
a signal function over data available at each decision point. It must be
structurally unable to see future bars.

Every result carries its assumptions — fee rate, slippage model, sample
window, number of variants tried.

Acceptance:
- A deliberately lookahead-biased signal is rejected or scores at chance.
- A known-flat strategy nets negative after fees and funding.
- The same spec run twice gives identical numbers.

### WP6 — Vercel control panel

Next.js: dashboards over the Postgres data, web chat against the eve runtime,
and admin over watched addresses and schedules. Browser talks only to Vercel;
Vercel's API routes talk to the VM.

Acceptance:
- Dashboards render from collected data.
- Web chat holds a conversation, including streaming.
- No credential for the VM ever reaches the browser.

## Traps

Verified failure modes, each of which breaks something quietly.

**A proxy that forwards only `/eve/` looks correct and hangs.** Sessions will
start, then stall forever when the workflow callback cannot reach the runtime.
`/.well-known/workflow/` must be forwarded too, unrewritten.

**An unpinned Workflow world gets rejected at boot.** The npm `latest` tag
lags behind the `5.0.0-beta` line eve requires, and the runtime refuses an
incompatible protocol version.

**`eve build` needs network access to the AI Gateway catalog.** It resolves
model metadata at build time and fails with a 403 without it — confirmed while
authoring WP1. CI and the VM both need `AI_GATEWAY_API_KEY` and egress, not
just the runtime.

**Markdown schedules cannot wait for a human.** Task-mode sessions run to
completion or fail. Anything that must pause for the operator needs the
handler form with a channel handoff.

**Hyperliquid's rate limit is per-IP, not per-process.** Collectors and chat
share one budget. Overrunning it penalizes everything at once.

## Open questions

- **Seed addresses for WP3.** Which accounts to start snapshotting. Suggested
  default: top of the public leaderboard, filtered by drawdown-adjusted
  persistence rather than headline PnL, then curated by hand.
- **Retention.** How long to keep per-minute snapshots before rolling up.
  Cheap to defer, expensive to decide wrong after a year of data.
