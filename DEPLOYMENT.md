# Deployment Guide

## Quick Reference

| Environment | RAM | Command | Recommended Platform |
|-------------|-----|---------|---------------------|
| Staging | 4 GB | `npm run docker:staging` | Old laptop/desktop |
| Production | 8 GB+ | `npm run docker:prod` | Hetzner CCX13 |

---

## Staging Deployment

### Old Laptop/Desktop (FREE)

Any computer with 4GB+ RAM works.

#### Setup

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone and deploy
git clone <your-repo-url>
cd MSW-Backend
cp .env.example .env
nano .env

npm run docker:staging
```

#### Access from Other Devices

**Option 1: Cloudflare Tunnel (Recommended)**
```bash
# Install Cloudflare Tunnel (free)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/

# Create tunnel (no account needed for quick tunnels)
cloudflared tunnel --url http://localhost:3000

# Outputs: https://random-name.trycloudflare.com
```

**Option 2: ngrok**
```bash
# Install ngrok
brew install ngrok  # macOS
snap install ngrok  # Linux

# Create tunnel
ngrok http 3000

# Outputs: https://random.ngrok.io
```

---

## Production Deployment (Hetzner)

### Step 1: Create Server

1. Go to https://www.hetzner.com → **Cloud Console**
2. **Add Server**:
   - **Image**: Ubuntu 24.04
   - **Type**: **CCX13** (8GB dedicated, €23.40/mo)
   - **Location**: Closest to users
3. **Networking**: Enable IPv4
4. **SSH Keys**: Add your public key
5. Click **Create & Buy**

### Step 2: Configure Firewall

1. Go to **Security → Firewalls** → Create `msw-production`
2. **Inbound Rules**:
   - Port 22 (SSH) - Your IP only
   - Port 80, 443 - 0.0.0.0/0
3. Apply to your server

### Step 3: Deploy

```bash
# SSH into server
ssh root@<server-ip>

# Create deploy user
adduser deploy
usermod -aG sudo,docker deploy
su - deploy

# Install dependencies
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
sudo apt install -y nodejs git docker-compose-plugin

# Clone and configure
git clone <your-repo-url>
cd MSW-Backend
cp .env.example .env
nano .env
```

### Step 4: Configure Production Environment

```bash
# Edit .env
NODE_ENV=production

# Use Backblaze B2 for production storage
S3_ENDPOINT=https://s3.us-west-000.backblazeb2.com
S3_ACCESS_KEY_ID=<your-key>
S3_SECRET_ACCESS_KEY=<your-secret>

# Enable backups
BACKUP_ENABLED=true
BACKUP_SCHEDULE="0 */6 * * *"
BACKUP_RETENTION_DAYS=30

# Auth keys
SENDER_PUBLIC_KEY=<your-public-key>
RECIPIENT_PRIVATE_KEY=<your-private-key>
```

### Step 5: Deploy

```bash
npm run docker:prod

# Verify
curl http://localhost:3000/health
```

### Step 6: Setup HTTPS with Caddy

```bash
sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
```

```
api.yourdomain.com {
    reverse_proxy localhost:3000
}

minio.yourdomain.com {
    reverse_proxy localhost:9001
}
```

```bash
sudo systemctl restart caddy
```

---

## Memory Requirements

| Service | Staging (4GB) | Production (8GB) |
|---------|---------------|------------------|
| redis-cache | 64 MB | 256 MB |
| redis-ephemeral | 512 MB | 1 GB |
| redis-stream | 64 MB | 128 MB |
| redis-audit | 256 MB | 1 GB |
| PostgreSQL | 1 GB | 2 GB |
| App | 512 MB | 1 GB |
| **Total** | ~2.4 GB | ~4.5 GB |

---

## Cost Comparison

| Platform | RAM | Storage | Price | Use Case |
|----------|-----|---------|-------|----------|
| Old laptop | 4 GB+ | varies | €0/mo | Staging |
| Hetzner CCX13 | 8 GB (dedicated) | 160 GB | €23.40/mo | Production |