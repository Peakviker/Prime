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
   **Outstanding:** deployed with this unset; model calls will 403 until the
   operator sets it in `/opt/prime/.env` and restarts.

Reverse proxy must forward **both** `/eve/` and `/.well-known/workflow/`,
with TLS and a public hostname (Telegram's webhook lands here).

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

Acceptance:
- `GET /eve/v1/health` answers — done, direct on port 3000; not yet through a
  reverse proxy (none configured yet, see above).
- `eve dev https://<host>` completes a real turn — blocked on
  `AI_GATEWAY_API_KEY`.
- A session survives a process restart — the health check recovers after
  `systemctl restart`, which is what the Postgres world makes possible;
  restarting mid-session to confirm the *session itself* resumes (not just
  that the process comes back) is still open, and needs a real model call to
  create a session in the first place.

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

Acceptance:
- A sweep runs on its cron cadence and writes rows.
- Interactive questions stay responsive while a sweep is running.
- Re-running a sweep does not duplicate rows.

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
