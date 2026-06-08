#!/bin/sh
set -e

# Monastery Entrypoint Script
# Starts the Rust API backend and Nginx frontend server

echo "=== Monastery Starting ==="

# Configure git identity globally for commits
git config --global user.email "monastery@homelab.local"
git config --global user.name "Monastery AI"
git config --global init.defaultBranch main

# Start the Rust API backend in the background on port 8080
echo "[harness-api] Starting API server on port 8080..."
PORT=8080 /app/harness &
HARNESS_PID=$!

# Wait for the API to become healthy
echo "[harness-api] Waiting for API to be ready..."
for i in $(seq 1 30); do
    if curl -s -f http://localhost:8080/api/health > /dev/null 2>&1; then
        echo "[harness-api] API is healthy!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "[harness-api] WARNING: API did not become healthy within 30s, starting nginx anyway..."
    fi
    sleep 1
done

# Start Nginx in the foreground
echo "[nginx] Starting Nginx on port 3000..."
exec nginx -g "daemon off;"
