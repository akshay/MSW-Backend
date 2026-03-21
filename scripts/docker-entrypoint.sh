#!/bin/sh
set -e

echo "Starting MSW Backend..."

# Wait for database to be ready
if [ -n "$DATABASE_URL" ]; then
	echo "Waiting for database..."
	until npx prisma db push --schema ./prisma/schema.prisma --skip-generate 2>/dev/null; do
		echo "Database is unavailable - sleeping"
		sleep 2
	done
	echo "Database is ready!"

	# Run migrations if needed
	echo "Applying database schema..."
	npx prisma db push --schema ./prisma/schema.prisma --skip-generate --accept-data-loss 2>/dev/null || true
fi

# Start the application
exec node server.js
