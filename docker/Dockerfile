# ============================================================
# Stage 1: Build the React/Vite frontend
# ============================================================
FROM node:20-bookworm-slim AS frontend-builder

WORKDIR /app/frontend

# Single COPY + single RUN — minimizes BuildKit snapshot layers
COPY packages/web-ui/ ./
RUN npm install && npx vite build --outDir dist --base /

# ============================================================
# Stage 2: Build the Rust backend binary
# ============================================================
FROM rust:1.86.0-bookworm AS backend-builder

WORKDIR /app

RUN apt-get update && apt-get install -y pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Single COPY + single RUN for the entire Rust workspace
COPY Cargo.toml Cargo.lock* ./
COPY crates/ ./crates/
RUN cargo build --release --bin harness

# ============================================================
# Stage 3: Nginx runtime (serves frontend + proxies API)
# ============================================================
FROM nginx:1.27-bookworm

RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/*

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-builder /app/frontend/dist /usr/share/nginx/html
COPY --from=backend-builder /app/target/release/harness /app/harness

RUN mkdir -p /app/data && chmod 777 /app/data

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
