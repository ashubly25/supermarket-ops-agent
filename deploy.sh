#!/usr/bin/env bash
# One-shot deploy for the Supermarket Ops Agent on a fresh Ubuntu/Debian VM.
# Run from inside the cloned repo:  bash deploy.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Installing Docker & git (if missing)…"
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y docker.io docker-compose-plugin git
  sudo systemctl enable --now docker
fi

# Use sudo for docker unless the current user is already in the docker group.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "==> Created .env — fill in your keys, then re-run:  bash deploy.sh"
  echo "    nano .env   # set TELEGRAM_BOT_TOKEN and AI_GATEWAY_API_KEY"
  exit 0
fi

if ! grep -q '^TELEGRAM_BOT_TOKEN=.\+' .env || ! grep -q '^AI_GATEWAY_API_KEY=.\+' .env; then
  echo "!! .env is missing TELEGRAM_BOT_TOKEN or AI_GATEWAY_API_KEY. Edit it and re-run." >&2
  exit 1
fi

echo "==> Building and starting…"
$DOCKER compose up -d --build

echo
echo "==> Up. Following logs (Ctrl-C to detach; the bot keeps running)…"
$DOCKER compose logs -f
