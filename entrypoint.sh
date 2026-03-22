#!/bin/bash
set -e

# Start Gunicorn in background
cd /app/server
gunicorn --bind 127.0.0.1:8081 --worker-class gevent --workers 1 --worker-connections 200 --timeout 300 "app:create_app()" &

# Start nginx in foreground
exec nginx -g "daemon off;"
