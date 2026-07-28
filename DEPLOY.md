# Deploy — Oracle Cloud Always Free VM

Goal: an always-on Telegram bot with a persistent SQLite file, free forever.

## 1. Create the bot
1. In Telegram, message **@BotFather** → `/newbot` → pick a name and `@username`.
2. Copy the token it gives you.

## 2. Provision the VM (one-time)
1. Oracle Cloud → **Compute → Instances → Create**.
2. Shape:`VM.Standard.E2.1.Micro`: the micro's 1 GB RAM OOMs during the image build(`deploy.sh`).
3. Image: **Ubuntu 22.04**. Add your SSH key. Create.
4. SSH in: `ssh ubuntu@<public-ip>`.

No inbound port needs opening — the bot long-polls, so it only makes outbound HTTPS.

## 3. Run the agent
```bash
git clone https://github.com/ashubly25/assessment.git supermarket-ops-agent
cd supermarket-ops-agent
bash deploy.sh    # installs Docker, copies .env.example → .env, then exits
nano .env         # set TELEGRAM_BOT_TOKEN + one of ANTHROPIC_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY
bash deploy.sh    # builds and starts; expect "Bot online as @<username>"
docker compose logs -f
```

`deploy.sh` handles the two Oracle-image traps: `iptables -P FORWARD REJECT`, which
silently kills *all* container egress because Docker appends its bridge rules after
that policy, and low-RAM shapes (adds a 2 GB swapfile).

`restart: always` keeps it up across reboots. The SQLite DB lives in the `store-data`
Docker volume, so stock / khata / bills / preferences survive restarts and redeploys.

## 4. Update later
```bash
git pull && docker compose up -d --build
```

## Notes
- No public URL / webhook needed — the bot uses Telegram long-polling.
- Open no inbound ports for the bot itself (outbound HTTPS only).
- Back up the DB: `docker run --rm -v supermarket-ops-agent_store-data:/d -v $PWD:/b alpine cp /d/store.db /b/`.
