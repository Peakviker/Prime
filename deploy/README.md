# Deploying Prime as a daemon (WP2)

Turns the eve runtime into a service that survives crashes, VM reboots, and
process restarts, per `docs/ARCHITECTURE.md`. Two independent pieces:

- **`prime.service`** — supervises the `eve start` process itself
  (`Restart=always`). Without this, a killed or crashed process just stays
  dead.
- **`docker-compose.yml`'s `postgres` service** — backs the Workflow world
  (`agent/agent.ts`'s `experimental.workflow.world`), so an in-flight agent
  session survives the process restarting, not just the process itself.
  Without it, `Restart=always` brings the server back up but every session
  in flight is lost, because the default Workflow world is in-memory.

Both matter: process supervision alone still loses sessions on restart, and
Postgres alone doesn't help if nothing restarts the crashed process.

## One-time setup

```bash
# 1. Clone the repo where the service will run from.
git clone https://github.com/Peakviker/Prime.git /opt/prime
cd /opt/prime

# 2. Create the service user and give it Docker access (the sandbox backend
#    in agent/sandbox.ts drives the Docker CLI directly).
sudo useradd --system --home /opt/prime --shell /usr/sbin/nologin prime || true
sudo usermod -aG docker prime
sudo chown -R prime:prime /opt/prime

# 3. Bring up Postgres for the Workflow world.
docker compose up -d postgres

# 4. Create the world-postgres schema. The package does not create it on
#    first connect — without this, prime.service starts but every session
#    fails with relation "workflow.workflow_runs" does not exist.
WORKFLOW_POSTGRES_URL=postgres://world:world@localhost:5432/world \
  npx --package=@workflow/world-postgres bootstrap

# 5. Configure secrets. Copy .env.example, fill in AI_GATEWAY_API_KEY (model
#    access off Vercel), ROUTE_AUTH_BASIC_USERNAME/PASSWORD, and
#    WORKFLOW_POSTGRES_URL (matches the docker-compose credentials by
#    default: postgres://world:world@localhost:5432/world).
sudo -u prime cp .env.example /opt/prime/.env
sudo -u prime $EDITOR /opt/prime/.env

# 6. Install and enable the systemd unit.
sudo cp deploy/prime.service /etc/systemd/system/prime.service
sudo systemctl daemon-reload
sudo systemctl enable prime
```

If a running `eve-app.service` or other ad-hoc unit already serves port 3000
from an earlier manual deploy, stop and disable it first — two processes
binding the same port will fight:

```bash
sudo systemctl disable --now eve-app.service
```

## Deploy (first run and every update)

```bash
cd /opt/prime
APP_DIR=/opt/prime deploy/deploy.sh
```

This installs dependencies, runs `eve build`, restarts `prime.service`, and
polls `/eve/v1/health` until it answers or 30s pass.

## Verify

```bash
systemctl status prime
curl http://127.0.0.1:3000/eve/v1/health
journalctl -u prime -f
```

Then prove the Workflow world is actually persisting, per the WP2 acceptance
criteria in `docs/ARCHITECTURE.md`: start a session, restart the service
mid-session, and confirm it resumes instead of vanishing.

```bash
sudo systemctl restart prime
```

## Not covered here

- **TLS and a public hostname.** Put a reverse proxy (Caddy, nginx) in front
  of port 3000 that forwards `/eve/` and `/.well-known/workflow/` unrewritten
  — see the "traps" section of `docs/ARCHITECTURE.md`. Required before
  Telegram's webhook or a real user can reach this.
- **Route auth beyond the httpBasic() fallback** already in
  `agent/channels/eve.ts`. Fine as a stopgap; replace with JWT/OIDC before
  the web chat carries real users (WP2 item 3 in the plan).
