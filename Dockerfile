## Stage 1: Build frontend
FROM node:22 AS frontend-build
RUN npm install -g bun
WORKDIR /build
COPY frontend/package.json frontend/bun.lock* ./
RUN bun install
COPY frontend/ .
RUN bun run build

## Stage 2: Runtime
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    intel-media-va-driver-non-free \
    vainfo \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
WORKDIR /app
COPY server/requirements.txt .
RUN python3 -m venv /app/venv && \
    /app/venv/bin/pip install --no-cache-dir -r requirements.txt

# Copy backend
COPY server/ ./server/

# Copy built frontend
COPY --from=frontend-build /build/dist ./frontend/dist

# Create directories
RUN mkdir -p /cache/thumbnails /config

ENV KMC_CONFIG=/config/config.yml
ENV KMC_CACHE_DIR=/cache/thumbnails
ENV KMC_STREAM_TMPDIR=/tmp/kmc_streams
ENV PATH="/app/venv/bin:$PATH"

EXPOSE 8080

WORKDIR /app/server
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "4", "--threads", "8", "--timeout", "300", "app:create_app()"]
