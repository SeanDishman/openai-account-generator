#!/usr/bin/env bash
# https://github.com/SeanDishman/openai-account-generator
#
# deploy.sh — provision mailcatch on a fresh Ubuntu/Debian VPS.
#
# WHAT IT DOES
#   * installs Node.js + nginx + certbot
#   * installs the app to /opt/mailcatch and runs it as a systemd service
#     (the service is allowed to bind privileged port 25 via CAP_NET_BIND_SERVICE)
#   * SMTP (port 25) is served directly by the app  -> receives mail for ANY address
#   * the web UI + API (port 3000, localhost only)  -> proxied to the public web by nginx
#   * opens the firewall for 22/25/80/443
#   * (optional) obtains a Let's Encrypt certificate for your domain
#
# USAGE  (run as root, ON the VPS, from inside the mailcatch/ folder):
#   sudo bash deploy.sh mail.example.com
#   sudo bash deploy.sh                       # IP-only, no domain / no TLS
#   sudo ENABLE_TLS=0 bash deploy.sh mail.example.com   # domain but skip cert
#
# Get the files onto the VPS first, e.g. from your laptop:
#   scp -r mailcatch root@146.19.248.208:/root/
#   ssh root@146.19.248.208
#   cd /root/mailcatch && sudo bash deploy.sh mail.example.com
#
set -euo pipefail

# ---- configuration --------------------------------------------------------
DOMAIN="${1:-${DOMAIN:-}}"
APP_DIR="/opt/mailcatch"
SERVICE_USER="mailcatch"
HTTP_PORT="${HTTP_PORT:-3000}"
SMTP_PORT="${SMTP_PORT:-25}"
ENABLE_TLS="${ENABLE_TLS:-1}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
NODE_MAJOR="${NODE_MAJOR:-20}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root:  sudo bash deploy.sh $*"
[ -f "$SCRIPT_DIR/server.js" ] || die "server.js not found next to deploy.sh — run this from inside the mailcatch/ folder."

if [ -z "$DOMAIN" ]; then
  warn "No domain given. Web UI will be served on the bare IP over HTTP only."
else
  say "Deploying mailcatch for domain: $DOMAIN"
fi

# ---- packages -------------------------------------------------------------
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg rsync

# Decide which web server fronts the HTTP UI. If Caddy is already running this
# box (common on pre-provisioned VPSes), USE it instead of fighting over ports
# 80/443 with nginx.
if command -v caddy >/dev/null 2>&1 || systemctl is-active --quiet caddy 2>/dev/null; then
  WEBSERVER=caddy
  say "Detected Caddy — using it for the HTTPS reverse proxy (skipping nginx)"
else
  WEBSERVER=nginx
  apt-get install -y nginx ufw
fi

if ! command -v node >/dev/null 2>&1; then
  say "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
say "Node $(node -v), npm $(npm -v)"

# ---- app user + files -----------------------------------------------------
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  say "Creating service user '$SERVICE_USER'"
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

say "Copying app to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules \
  --exclude data \
  --exclude '.git' \
  "$SCRIPT_DIR/"  "$APP_DIR/"
mkdir -p "$APP_DIR/data"

say "Installing production dependencies"
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund )

chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"

# ---- systemd service ------------------------------------------------------
say "Writing systemd unit"
cat >/etc/systemd/system/mailcatch.service <<UNIT
[Unit]
Description=mailcatch — wildcard catch-all mail server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=2

# let the non-root service bind privileged port 25
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

# SMTP is public; the web/API is kept on localhost and exposed via nginx
Environment=SMTP_HOST=0.0.0.0
Environment=SMTP_PORT=$SMTP_PORT
Environment=HTTP_HOST=127.0.0.1
Environment=HTTP_PORT=$HTTP_PORT
Environment=DATA_FILE=$APP_DIR/data/emails.json

# light hardening
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable mailcatch
systemctl restart mailcatch

# ---- reverse proxy + TLS --------------------------------------------------
# In case a previous run left nginx failed/fighting for the ports, stop it.
if [ "$WEBSERVER" = "caddy" ]; then
  systemctl disable --now nginx >/dev/null 2>&1 || true
fi

if [ "$WEBSERVER" = "caddy" ]; then
  # Caddy already owns 80/443. Add a site block for our domain and reload;
  # Caddy fetches + renews a real Let's Encrypt cert automatically.
  CADDYFILE=/etc/caddy/Caddyfile
  mkdir -p /etc/caddy
  touch "$CADDYFILE"
  if [ -n "$DOMAIN" ]; then
    if grep -qF "$DOMAIN" "$CADDYFILE"; then
      say "$DOMAIN already in $CADDYFILE — leaving it as-is"
    else
      say "Adding $DOMAIN to Caddy (auto-HTTPS via Let's Encrypt)"
      printf '\n%s {\n    reverse_proxy localhost:%s\n}\n' "$DOMAIN" "$HTTP_PORT" >> "$CADDYFILE"
    fi
    if caddy validate --config "$CADDYFILE" >/dev/null 2>&1; then
      systemctl reload caddy || systemctl restart caddy
      say "Caddy reloaded — https://$DOMAIN is live."
    else
      warn "Caddyfile failed validation. Inspect it:  caddy validate --config $CADDYFILE"
    fi
  else
    warn "No domain given; with Caddy in front the app is only on 127.0.0.1:$HTTP_PORT."
    warn "Add a block to $CADDYFILE to expose it publicly."
  fi
  # only touch the firewall if ufw is already active (don't enable it and risk lockout)
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    for p in 22 25 80 443; do ufw allow "$p"/tcp >/dev/null 2>&1 || true; done
  fi

else
  # ---- nginx reverse proxy (only when Caddy is NOT already running) ----------
  say "Configuring nginx reverse proxy"
  SERVER_NAME="${DOMAIN:-_}"
  cat >/etc/nginx/sites-available/mailcatch <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;

    location / {
        proxy_pass http://127.0.0.1:$HTTP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX

  ln -sf /etc/nginx/sites-available/mailcatch /etc/nginx/sites-enabled/mailcatch
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable nginx
  systemctl restart nginx

  # firewall
  say "Configuring firewall (ufw)"
  ufw allow 22/tcp   >/dev/null 2>&1 || true   # SSH — don't lock yourself out
  ufw allow 25/tcp   >/dev/null 2>&1 || true   # SMTP (inbound mail)
  ufw allow 80/tcp   >/dev/null 2>&1 || true   # HTTP
  ufw allow 443/tcp  >/dev/null 2>&1 || true   # HTTPS
  yes | ufw enable   >/dev/null 2>&1 || true

  # TLS
  if [ -n "$DOMAIN" ] && [ "$ENABLE_TLS" = "1" ]; then
    say "Requesting Let's Encrypt certificate for $DOMAIN"
    apt-get install -y certbot python3-certbot-nginx
    CERTBOT_EMAIL_ARG="--register-unsafely-without-email"
    [ -n "$LETSENCRYPT_EMAIL" ] && CERTBOT_EMAIL_ARG="-m $LETSENCRYPT_EMAIL"
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos $CERTBOT_EMAIL_ARG --redirect; then
      say "TLS enabled."
    else
      warn "certbot failed — is the DNS A record for $DOMAIN pointing at this server yet?"
      warn "You can re-run:  certbot --nginx -d $DOMAIN"
    fi
  fi
fi

# ---- done -----------------------------------------------------------------
IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || echo '146.19.248.208')"
if [ -n "$DOMAIN" ]; then BASE="https://$DOMAIN"; else BASE="http://$IP"; fi
say "Done."
systemctl --no-pager --lines=8 status mailcatch || true
cat <<DONE

--------------------------------------------------------------------
 mailcatch is live.

   SMTP  : port 25 on this server ($IP) — accepts mail for ANY address
   Web UI: $BASE/          (password-protected — log in to view)
   API   : $BASE/api/latest
           $BASE/api/emails
   API auth:  curl -H "X-Api-Key: <password>" $BASE/api/latest

 Send a test from anywhere:
   swaks --to test@${DOMAIN:-yourdomain} --server $IP
   (or just have any service email  anything@${DOMAIN:-yourdomain})

 Manage the service:
   systemctl status mailcatch
   journalctl -u mailcatch -f     # live logs of incoming mail

 !! DNS: point your domain's MX record at this server. See README.md.
--------------------------------------------------------------------
DONE
