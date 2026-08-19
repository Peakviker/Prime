#!/usr/bin/env bash
# Build and (re)start Prime as the prime.service systemd daemon.
# Run as the deploy user on the VM, from anywhere; APP_DIR must already be a
# checkout of this repo with deploy/prime.service installed (see deploy/README.md).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/prime}"
SERVICE="${SERVICE:-prime}"

cd "$APP_DIR"

echo "==> pnpm install"
pnpm install --frozen-lockfile

echo "==> eve build"
pnpm exec eve build

echo "==> restarting $SERVICE.service"
sudo systemctl restart "$SERVICE"

echo "==> waiting for health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT:-3000}/eve/v1/health" >/dev/null 2>&1; then
    echo "healthy after ${i}s"
    exit 0
  fi
  sleep 1
done

echo "!! health check did not pass within 30s; check: journalctl -u $SERVICE -n 100" >&2
exit 1
