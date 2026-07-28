# Deploy — Oracle Cloud Always Free VM

Goal: an always-on Telegram bot with a persistent SQLite file, free forever.

## 1. Create the bot
1. In Telegram, message **@BotFather** → `/newbot` → pick a name and `@username`.
2. Copy the token it gives you.

## 2. Provision the VM (one-time)
1. Oracle Cloud → **Compute → Instances → Create**.
2. Shape: **Ampere A1 (ARM)** or **VM.Standard.E2.1.Micro (x86)** — both are in the *Always Free* tier.
3. Image: **Ubuntu 22.04**. Add your SSH key. Create.
4. SSH in: `ssh ubuntu@<public-ip>`.

## 3. Install Docker
```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER && newgrp docker
```

## 4. Run the agent
```bash
git clone <your-repo> supermarket-ops-agent && cd supermarket-ops-agent
cp .env.example .env
nano .env         # set TELEGRAM_BOT_TOKEN and AI_GATEWAY_API_KEY
docker compose up -d --build
docker compose logs -f          # expect: "Bot online as @<username>"
```

`restart: always` keeps it up across reboots. The SQLite DB lives in the `store-data`
Docker volume, so stock / khata / bills / preferences survive restarts and redeploys.

## 5. Update later
```bash
git pull && docker compose up -d --build
```

## Notes
- No public URL / webhook needed — the bot uses Telegram long-polling.
- Open no inbound ports for the bot itself (outbound HTTPS only).
- Back up the DB: `docker run --rm -v supermarket-ops-agent_store-data:/d -v $PWD:/b alpine cp /d/store.db /b/`.
