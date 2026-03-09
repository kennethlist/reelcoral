#!/bin/bash
set -e

SSL_DIR="/data/ssl"
NGINX_SSL_DIR="/etc/nginx/ssl"

# Generate self-signed cert if not already present
if [ ! -f "$SSL_DIR/cert.pem" ] || [ ! -f "$SSL_DIR/key.pem" ]; then
    echo "Generating self-signed TLS certificate..."
    mkdir -p "$SSL_DIR"
    openssl req -x509 -nodes -days 3650 \
        -newkey rsa:2048 \
        -keyout "$SSL_DIR/key.pem" \
        -out "$SSL_DIR/cert.pem" \
        -subj "/CN=reelcoral"
fi

# Symlink certs to nginx ssl dir
mkdir -p "$NGINX_SSL_DIR"
ln -sf "$SSL_DIR/cert.pem" "$NGINX_SSL_DIR/cert.pem"
ln -sf "$SSL_DIR/key.pem" "$NGINX_SSL_DIR/key.pem"

# Start Gunicorn in background
cd /app/server
gunicorn --bind 127.0.0.1:8081 --worker-class gevent --workers 1 --worker-connections 200 --timeout 300 "app:create_app()" &

# Start nginx in foreground
exec nginx -g "daemon off;"
