# Build stage
FROM rust:1.86.0-bookworm AS builder

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

# Runtime stage
FROM debian:bookworm-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy binary from builder
COPY --from=builder /app/target/release/harness /app/harness

# Create data directory with proper permissions
RUN mkdir -p /app/data && chmod 777 /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Run the binary
ENTRYPOINT ["/app/harness"]
