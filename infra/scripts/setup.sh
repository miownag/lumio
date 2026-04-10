#!/bin/bash
# Lumio development environment setup
set -e

echo "Setting up Lumio development environment..."

# Start infrastructure
echo "Starting infrastructure services..."
docker compose up -d postgres redis minio

# Wait for services
echo "Waiting for PostgreSQL..."
until docker compose exec postgres pg_isready; do
  sleep 1
done

# Install dependencies
echo "Installing dependencies..."
bun install

# Run migrations
echo "Running database migrations..."
bun run db:migrate

echo "Setup complete! Run 'bun run dev' to start development."
