#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

log_info "Starting deployment of RO IT Systems infrastructure"
log_info "Repository root: $REPO_ROOT"

# 1. INFRASTRUCTURE
log_info "=== DEPLOYING INFRASTRUCTURE ==="
cd "$REPO_ROOT/infrastructure"

if [ ! -f .env ]; then
  log_error ".env file not found in $REPO_ROOT/infrastructure/"
  log_error "Please create .env with COUCHDB_USER and COUCHDB_PASSWORD"
  exit 1
fi

log_info "Pulling latest changes..."
git pull origin main

log_info "Stopping and cleaning up infrastructure..."
docker-compose down -v --remove-orphans || true
docker system prune -af || true

log_info "Starting infrastructure services (Caddy, NATS, CouchDB)..."
docker-compose up -d

log_info "Waiting for services to stabilize..."
sleep 10

# 2. CONTACT-INBOX
log_info "=== DEPLOYING CONTACT-INBOX ==="
cd "$REPO_ROOT/corporate-network/contact-inbox"

if [ ! -f .env ]; then
  log_error ".env file not found in $REPO_ROOT/corporate-network/contact-inbox/"
  log_error "Please create .env with COUCHDB_USER, COUCHDB_PASSWORD, NATS_URL, ADMIN_TOKEN"
  exit 1
fi

log_info "Pulling latest changes..."
git pull origin main

log_info "Stopping and cleaning up contact-inbox..."
docker-compose down -v --remove-orphans || true

log_info "Starting contact-inbox services..."
docker-compose up -d

log_info "Waiting for API to start..."
sleep 5

# 3. IMAGE-CONVERTER
log_info "=== DEPLOYING IMAGE-CONVERTER ==="
cd "$REPO_ROOT/corporate-network/image-converter"

if [ ! -f .env ]; then
  log_warn ".env file not found in $REPO_ROOT/corporate-network/image-converter/"
  log_warn "Creating default .env..."
  cat > .env << ENVEOF
NATS_URL=nats://nats:4222
ADMIN_TOKEN=changeme
LOG_LEVEL=info
ENVEOF
fi

log_info "Pulling latest changes..."
git pull origin main

log_info "Stopping and cleaning up image-converter..."
docker-compose down -v --remove-orphans || true

log_info "Starting image-converter services..."
docker-compose up -d

log_info "Waiting for services to stabilize..."
sleep 5

# 4. VERIFICATION
log_info "=== VERIFYING DEPLOYMENT ==="

log_info "Running containers:"
docker ps | grep -E "caddy|contact-inbox|image-converter|nats|couchdb" || log_warn "Some services not found"

log_info "Testing health endpoint..."
if curl -s https://pubapi.roitsystems.ca/health > /dev/null 2>&1; then
  log_info "✓ Health check passed"
else
  log_warn "Health check failed - services may still be starting"
fi

log_info "=== DEPLOYMENT COMPLETE ==="
log_info "Infrastructure: $REPO_ROOT/infrastructure"
log_info "Contact-inbox: $REPO_ROOT/corporate-network/contact-inbox"
log_info "Image-converter: $REPO_ROOT/corporate-network/image-converter"
log_info ""
log_info "View logs with:"
log_info "  docker logs infrastructure_caddy_1"
log_info "  docker logs contact-inbox-api"
log_info "  docker logs image-converter-api"
