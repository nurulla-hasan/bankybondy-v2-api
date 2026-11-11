#!/bin/bash
set -e

APP_DIR="/root/bankybondy"
cd "$APP_DIR"

SERVICE=${1:-all}

case "$SERVICE" in
  backend|api)
    echo "=========================================="
    echo "🔄 Updating Backend from GitHub..."
    echo "=========================================="
    cd "$APP_DIR/backend"
    git pull origin main
    cd "$APP_DIR"
    echo "🔨 Rebuilding and restarting Backend & Worker..."
    docker compose up -d --build backend worker
    ;;
  frontend|web)
    echo "=========================================="
    echo "🔄 Updating Frontend from GitHub..."
    echo "=========================================="
    cd "$APP_DIR/frontend"
    git pull origin main
    cd "$APP_DIR"
    echo "🔨 Rebuilding and restarting Frontend..."
    docker compose up -d --build frontend
    ;;
  dashboard|admin)
    echo "=========================================="
    echo "🔄 Updating Dashboard from GitHub..."
    echo "=========================================="
    cd "$APP_DIR/dashboard"
    git pull origin main
    cd "$APP_DIR"
    ;;
  all)
    echo "=========================================="
    echo "🔄 Updating All Services from GitHub..."
    echo "=========================================="
    [ -d "$APP_DIR/frontend" ] && (cd "$APP_DIR/frontend" && git pull origin main)
    [ -d "$APP_DIR/backend" ] && (cd "$APP_DIR/backend" && git pull origin main)
    [ -d "$APP_DIR/dashboard" ] && (cd "$APP_DIR/dashboard" && git pull origin main)
    cd "$APP_DIR"
    echo "🔨 Rebuilding and restarting all containers..."
    docker compose up -d --build
    ;;
  status|ps)
    docker compose ps
    exit 0
    ;;
  logs)
    docker compose logs -f --tail=50 ${2:-backend}
    exit 0
    ;;
  *)
    echo "❌ Invalid option: $SERVICE"
    echo "Usage:"
    echo "  update backend   (or ./update.sh backend)   # Updates only Backend & Worker"
    echo "  update frontend  (or ./update.sh frontend)  # Updates only Frontend"
    echo "  update dashboard (or ./update.sh dashboard) # Updates only Dashboard"
    echo "  update all       (or ./update.sh all)       # Updates everything"
    echo "  update status                               # Shows running containers"
    echo "  update logs                                 # Shows backend logs"
    exit 1
    ;;
esac

echo ""
echo "✅ Update complete! Checking containers..."
docker compose ps
