#!/bin/bash
set -e

echo "=========================================="
echo "  MSW Backend - Staging Setup"
echo "=========================================="
echo ""

if [[ "$OSTYPE" == "darwin"* ]]; then
	OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
	OS="linux"
else
	echo "Unsupported OS: $OSTYPE"
	exit 1
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}[1/6] Checking Docker...${NC}"
if ! command -v docker &>/dev/null; then
	echo "Installing Docker..."
	if [[ "$OS" == "macos" ]]; then
		if command -v brew &>/dev/null; then
			brew install --cask docker
			echo "Docker Desktop installed. Please open it and wait for it to start, then re-run this script."
			exit 0
		else
			echo "Please install Homebrew first: https://brew.sh"
			exit 1
		fi
	else
		curl -fsSL https://get.docker.com | sh
		sudo usermod -aG docker $USER
		echo "Docker installed. You may need to log out and back in for group changes to take effect."
	fi
else
	echo -e "${GREEN}Docker already installed${NC}"
fi

if ! docker info &>/dev/null; then
	echo "Docker is not running. Please start Docker and try again."
	if [[ "$OS" == "macos" ]]; then
		echo "Open Docker Desktop from Applications"
	else
		echo "Run: sudo systemctl start docker"
	fi
	exit 1
fi

echo -e "${YELLOW}[2/6] Installing Cloudflare Tunnel...${NC}"
if ! command -v cloudflared &>/dev/null; then
	if [[ "$OS" == "macos" ]]; then
		brew install cloudflared
	else
		curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared
		chmod +x /tmp/cloudflared
		sudo mv /tmp/cloudflared /usr/local/bin/
	fi
	echo -e "${GREEN}cloudflared installed${NC}"
else
	echo -e "${GREEN}cloudflared already installed${NC}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo -e "${YELLOW}[3/6] Setting up repository...${NC}"
if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
	echo "Cloning repository..."
	read -p "Enter repo URL: " REPO_URL
	git clone "$REPO_URL" "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"

echo -e "${YELLOW}[4/6] Starting Docker services...${NC}"
if [[ ! -f .env ]]; then
	cp .env.example .env
fi

npm run docker:staging

echo "Waiting for MinIO to start..."
sleep 15
MAX_RETRIES=30
RETRY_COUNT=0
while ! curl -s http://localhost:9000/minio/health/live >/dev/null; do
	RETRY_COUNT=$((RETRY_COUNT + 1))
	if [[ $RETRY_COUNT -ge $MAX_RETRIES ]]; then
		echo "MinIO failed to start. Check logs: npm run docker:logs"
		exit 1
	fi
	sleep 2
done
echo -e "${GREEN}MinIO is ready${NC}"

echo -e "${YELLOW}[5/6] Loading auth keys...${NC}"

KEYS_FILE=".env.keys"
if [[ ! -f "$KEYS_FILE" ]]; then
	echo "Could not find .env.keys file."
	echo ""
	echo "Run MSW-Tools (outputCsvKey) to generate keys first:"
	echo "  cd ../MSW-Tools && go run ."
	echo ""
	echo "This will create .env.keys with the required auth keys."
	exit 1
fi

SENDER_PUBLIC_KEY=$(grep "^SENDER_PUBLIC_KEY=" "$KEYS_FILE" | cut -d'=' -f2)
RECIPIENT_PRIVATE_KEY=$(grep "^RECIPIENT_PRIVATE_KEY=" "$KEYS_FILE" | cut -d'=' -f2)

if [[ -z "$SENDER_PUBLIC_KEY" || -z "$RECIPIENT_PRIVATE_KEY" ]]; then
	echo "Invalid .env.keys file. Missing required keys."
	exit 1
fi

echo -e "${GREEN}Loaded auth keys from .env.keys${NC}"

echo -e "${YELLOW}[6/6] Updating .env with auth keys...${NC}"

if grep -q "^SENDER_PUBLIC_KEY=" .env; then
	if [[ "$OS" == "macos" ]]; then
		sed -i '' "s|^SENDER_PUBLIC_KEY=.*|SENDER_PUBLIC_KEY=${SENDER_PUBLIC_KEY}|" .env
		sed -i '' "s|^RECIPIENT_PRIVATE_KEY=.*|RECIPIENT_PRIVATE_KEY=${RECIPIENT_PRIVATE_KEY}|" .env
	else
		sed -i "s|^SENDER_PUBLIC_KEY=.*|SENDER_PUBLIC_KEY=${SENDER_PUBLIC_KEY}|" .env
		sed -i "s|^RECIPIENT_PRIVATE_KEY=.*|RECIPIENT_PRIVATE_KEY=${RECIPIENT_PRIVATE_KEY}|" .env
	fi
else
	echo "" >>.env
	echo "# Auth keys (added by setup-staging.sh)" >>.env
	echo "SENDER_PUBLIC_KEY=${SENDER_PUBLIC_KEY}" >>.env
	echo "RECIPIENT_PRIVATE_KEY=${RECIPIENT_PRIVATE_KEY}" >>.env
fi

echo -e "${GREEN}Auth keys added to .env${NC}"

echo ""
echo "=========================================="
echo "  Configuration Summary"
echo "=========================================="
echo ""
echo "  SENDER_PUBLIC_KEY=${SENDER_PUBLIC_KEY}"
echo "  RECIPIENT_PRIVATE_KEY=${RECIPIENT_PRIVATE_KEY}"
echo ""
echo "  Game client uses Key.csv (sender private key)"
echo "  Backend uses these keys from .env"
echo ""
echo "=========================================="

echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "Starting Cloudflare Tunnel for public access..."
echo "Press Ctrl+C to stop."
echo ""

cleanup() {
	echo ""
	echo "Stopping tunnel and services..."
	npm run docker:down 2>/dev/null || true
	exit 0
}
trap cleanup INT TERM

cloudflared tunnel --url http://localhost:3000
