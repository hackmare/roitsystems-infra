#!/bin/bash
set -e

# Deployment script for roitsystems-infra
# Run from the root directory: ./deploy.sh

if [ ! -f .env ]; then
  echo "ERROR: .env file not found in $(pwd)"
  echo "Copy .env.example to .env and fill in the required values:"
  echo "  cp .env.example .env"
  exit 1
fi

# Load environment variables
export $(cat .env | grep -v '^#' | xargs)

echo "🚀 Deploying roitsystems-infra..."
echo "   API Domain: $API_DOMAIN"

# Kill existing containers to avoid conflicts
echo "🔥 Cleaning up old containers..."
docker kill $(docker ps -q) 2>/dev/null || true
docker system prune -f -a >/dev/null 2>&1 || true
sleep 2

# Start infrastructure layer (Caddy, NATS, CouchDB)
echo "🏗️  Starting infrastructure layer..."
cd infrastructure
docker-compose --env-file ../.env up -d --build
cd ..

echo "⏳ Waiting for CouchDB to initialize (15 seconds)..."
sleep 15

# Start contact-inbox app
echo "📮 Starting contact-inbox app..."
cd corporate-network/contact-inbox
docker-compose --env-file ../../.env up -d --build
cd ../..

# Start image-converter app
echo "🖼️  Starting image-converter app..."
cd corporate-network/image-converter
docker-compose --env-file ../../.env up -d --build
cd ../..

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Services running:"
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "caddy|nats|couchdb|contact|image"
echo ""
echo "Test endpoints:"
echo "  Health check: curl https://$API_DOMAIN/health"
echo "  Contact form: https://$API_DOMAIN/corporate-network/contact"
echo "  Contact admin: https://$API_DOMAIN/corporate-network/contact/admin"
echo "  Image converter: https://$API_DOMAIN/corporate-network/image-converter/convert"
