#!/usr/bin/env bash
# One-shot deploy for the Supermarket Ops Agent on a fresh Oracle Cloud Always Free VM
# (Ubuntu or Oracle Linux, x86_64 or Ampere ARM). Run from inside the cloned repo:
#   bash deploy.sh
set -euo pipefail

cd "$(dirname "$0")"

# ---------------------------------------------------------------- packages
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker & git…"
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo apt-get install -y docker.io docker-compose-plugin git
  elif command -v dnf >/dev/null 2>&1; then
    # Oracle Linux images ship podman-docker, which shadows the real docker CLI.
    sudo dnf remove -y podman-docker runc >/dev/null 2>&1 || true
    sudo dnf install -y dnf-utils git
    sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  else
    echo "!! No apt-get or dnf. Install Docker manually, then re-run." >&2
    exit 1
  fi
  sudo systemctl enable --now docker
fi

# Use sudo for docker unless the current user is already in the docker group.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi

# ---------------------------------------------------------------- Oracle firewall
# Oracle's stock images ship an iptables FORWARD policy of REJECT. Docker appends its
# bridge rules *after* that, so containers get no outbound network — the bot would boot
# and then fail every Telegram / Gateway call. Nothing inbound is opened here: the bot
# long-polls, so it needs egress only.
if command -v iptables >/dev/null 2>&1 && sudo iptables -S FORWARD 2>/dev/null | grep -q '^-P FORWARD REJECT'; then
  echo "==> Oracle FORWARD=REJECT detected — allowing Docker bridge egress…"
  sudo iptables -P FORWARD ACCEPT
  if command -v netfilter-persistent >/dev/null 2>&1; then
    sudo netfilter-persistent save
  else
    echo "   (not persisted across reboot — install iptables-persistent to make it stick)"
  fi
fi

# ---------------------------------------------------------------- swap
# VM.Standard.E2.1.Micro has 1 GB RAM; `npm install` + tsc during the image build OOMs
# there. Ampere A1 (24 GB) does not need this.
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 2048 ] && [ ! -f /swapfile ]; then
  echo "==> Only ${MEM_MB}MB RAM — adding a 2G swapfile so the build doesn't OOM…"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# ---------------------------------------------------------------- secrets
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

# ---------------------------------------------------------------- run
echo "==> Building and starting…"
$DOCKER compose up -d --build

echo
echo "==> Up. Following logs (Ctrl-C to detach; the bot keeps running)…"
$DOCKER compose logs -f
