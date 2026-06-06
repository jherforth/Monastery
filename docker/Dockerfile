# ============================================================
# Stage 1: Build the React/Vite frontend
# ============================================================
FROM node:20-bookworm-slim AS frontend-builder

WORKDIR /app/frontend

# Install pnpm for faster builds (optional, falls back to npm)
RUN npm install -g pnpm

# Copy frontend package files
COPY packages/web-ui/package.json packages/web-ui/pnpm-lock.yaml* packages/web-ui/package-lock.json* ./

# Install dependencies
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

# Copy frontend source
COPY packages/web-ui/ ./

# Build the frontend
RUN npx vite build --outDir dist --base /

# ============================================================
# Stage 2: Build the Rust backend binary
# ============================================================
FROM rust:1.86.0-bookworm AS backend-builder

WORKDIR /app

# Install dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace files
COPY Cargo.toml Cargo.lock* ./
COPY crates/harness-core/Cargo.toml ./crates/harness-core/
COPY crates/harness-api/Cargo.toml ./crates/harness-api/
COPY crates/harness-agent/Cargo.toml ./crates/harness-agent/

# Cache dependencies
RUN mkdir -p crates/harness-core/src crates/harness-api/src crates/harness-agent/src
RUN touch crates/harness-core/src/lib.rs crates/harness-api/src/main.rs crates/harness-agent/src/lib.rs

# Copy source code
COPY crates/ ./crates/

# Build the binary
RUN cargo build --release --bin harness

# ============================================================
# Stage 3: Nginx runtime (serves frontend + proxies API)
# ============================================================
FROM nginx:1.27-bookworm

# Install curl for health checks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Copy nginx configuration
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist /usr/share/nginx/html

# Copy Rust backend binary from Stage 2
COPY --from=backend-builder /app/target/release/harness /app/harness

# Create data directory with proper permissions
RUN mkdir -p /app/data && chmod 777 /app/data

# Copy startup script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
