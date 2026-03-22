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
    unrar \
    nginx \
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
RUN mkdir -p /cache/thumbnails /data

ENV MEDIA_CONFIG=/data/config.yml
ENV MEDIA_DATA_DIR=/data
ENV MEDIA_CACHE_DIR=/cache/thumbnails
ENV MEDIA_STREAM_TMPDIR=/tmp/media_streams
ENV PATH="/app/venv/bin:$PATH"

# nginx config and entrypoint
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8080

CMD ["/app/entrypoint.sh"]
