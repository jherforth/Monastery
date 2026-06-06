#!/usr/bin/env bash
# Monastery — One-command build & deploy
# Usage: ./build.sh

set -e

echo "=== Monastery Build ==="

# Detect if BuildKit is problematic (common in LXC/Proxmox environments)
# and disable it automatically for reliable builds.
if [ -f /.dockerenv ] || grep -q container=lxc /proc/1/environ 2>/dev/null; then
    echo "[info] LXC/container environment detected — using classic builder"
    export DOCKER_BUILDKIT=0
fi

echo "[1/2] Building Monastery image..."
docker compose build --no-cache

echo "[2/2] Starting Monastery..."
docker compose up -d

echo "[3/3] Cleaning up unused build layers..."
docker image prune -f 2>/dev/null || true

echo ""
echo "=== Monastery is running! ==="
echo "Open: http://localhost:3000"
echo "Health check: http://localhost:3000/api/health"
echo ""
echo "To stop:  docker compose down"
echo "To view logs: docker compose logs -f"
