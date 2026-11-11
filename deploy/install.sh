#!/usr/bin/env bash
# Flowboard team server — one-shot installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/quocbao1772003-spec/FLOW-BY-QB/main/deploy/install.sh | sudo bash
#   (or, inside a checkout:  sudo bash deploy/install.sh)
#
# Runs in its own folder (/opt/flowboard) and its own Docker containers, so it
# does not touch other apps on the same server. Public access goes through a
# Cloudflare Tunnel (no ports opened). Re-run any time to update.
set -euo pipefail

DIR="${FLOWBOARD_DIR:-/opt/flowboard}"
REPO="${FLOWBOARD_REPO:-https://github.com/quocbao1772003-spec/FLOW-BY-QB.git}"
BRANCH="${FLOWBOARD_BRANCH:-main}"

say() { printf '\n\033[1;35m== %s\033[0m\n' "$*"; }
ask() { # ask VAR "question" [default]
  local var=$1 q=$2 def=${3:-} ans
  if [ -n "${!var:-}" ]; then return; fi
  read -r -p "$q${def:+ [$def]}: " ans </dev/tty || true
  printf -v "$var" '%s' "${ans:-$def}"
}

[ "$(id -u)" = 0 ] || { echo "Chay bang root (sudo)."; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  say "Cai Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "Thieu docker compose plugin."; exit 1; }
command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }

say "Lay ma nguon vao $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" reset --hard --quiet "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"
mkdir -p storage

if [ ! -f .env ]; then
  say "Cau hinh lan dau"
  ask FLOWBOARD_DOMAIN "Ten mien cua Flowboard" "flowboard.flowytb.app"
  ask TUNNEL_TOKEN "Token tunnel RIENG cho Flowboard (bo trong = dung chung tunnel dang chay tren server)"
  ask FLOWBOARD_ADMIN_USER "Ten dang nhap admin" "admin"
  ask FLOWBOARD_ADMIN_PASSWORD "Mat khau admin (bo trong = tu tao)"
  ask CLAUDE_CODE_OAUTH_TOKEN "Token Claude Code cho AI (claude setup-token, bo trong neu chua co)"
  if [ -z "${FLOWBOARD_ADMIN_PASSWORD}" ]; then
    FLOWBOARD_ADMIN_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 14)
    GENERATED_PW=1
  fi
  PORT=8101
  while ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; do PORT=$((PORT + 1)); done
  umask 077
  cat > .env <<EOF
FLOWBOARD_HOST_PORT=${PORT}
COMPOSE_PROFILES=${TUNNEL_TOKEN:+tunnel}
FLOWBOARD_ADMIN_USER=${FLOWBOARD_ADMIN_USER}
FLOWBOARD_ADMIN_PASSWORD=${FLOWBOARD_ADMIN_PASSWORD}
FLOWBOARD_ALLOWED_ORIGINS=https://${FLOWBOARD_DOMAIN}
TUNNEL_TOKEN=${TUNNEL_TOKEN}
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}
EOF
fi

# Plug into a cloudflared that already runs on this server (shared tunnel).
HOST_PORT=$(sed -n 's/^FLOWBOARD_HOST_PORT=//p' .env); HOST_PORT=${HOST_PORT:-8101}
SERVICE_URL=""
if ! grep -q '^COMPOSE_PROFILES=tunnel' .env; then
  CF=$(docker ps --format '{{.Names}} {{.Image}}' | grep -i cloudflared | grep -v '^flowboard-' | head -n1 | cut -d' ' -f1 || true)
  if [ -n "$CF" ]; then
    MODE=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CF")
    if [ "$MODE" = host ]; then
      SERVICE_URL="http://localhost:${HOST_PORT}"
      rm -f docker-compose.override.yml
    else
      NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CF" | awk '{print $1}')
      cat > docker-compose.override.yml <<YML
# Written by deploy/install.sh: joins the network of the existing
# cloudflared container "$CF" so its tunnel can reach Flowboard.
services:
  flowboard:
    networks:
      default: {}
      edge:
        aliases: [flowboard-app]
networks:
  edge:
    external: true
    name: ${NET}
YML
      SERVICE_URL="http://flowboard-app:8101"
    fi
    echo "Dung chung cloudflared dang chay: $CF ($MODE)"
  elif pgrep -x cloudflared >/dev/null 2>&1; then
    SERVICE_URL="http://localhost:${HOST_PORT}"
    rm -f docker-compose.override.yml
    echo "Dung chung cloudflared cai tren may (khong phai Docker)"
  else
    echo "CANH BAO: khong thay cloudflared nao tren server va chua co TUNNEL_TOKEN."
  fi
fi

say "Build va chay (lan dau mat vai phut)"
docker compose -p flowboard up -d --build

say "Doi app khoi dong"
for _ in $(seq 1 60); do
  if docker compose -p flowboard exec -T flowboard python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8101/api/health', timeout=3)" >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done
[ "${OK:-}" = 1 ] || { echo "App chua len. Xem log: docker compose -p flowboard logs flowboard"; exit 1; }

DOMAIN=$(sed -n 's#^FLOWBOARD_ALLOWED_ORIGINS=https://##p' .env | cut -d, -f1)
say "XONG"
if [ -n "$SERVICE_URL" ]; then
  echo "  Cloudflare Zero Trust > Networks > Tunnels > (tunnel dang dung) > Public Hostname > Add:"
  echo "     Subdomain + Domain: ${DOMAIN}"
  echo "     Service:            HTTP   ${SERVICE_URL#http://}"
fi
echo "  Mo:        https://${DOMAIN}"
if [ "${GENERATED_PW:-}" = 1 ]; then
  echo "  Dang nhap: ${FLOWBOARD_ADMIN_USER} / ${FLOWBOARD_ADMIN_PASSWORD}   (doi mat khau sau khi vao)"
fi
echo "  Cap nhat:  chay lai lenh cai dat nay"
echo "  Log:       cd $DIR && docker compose -p flowboard logs -f flowboard"
