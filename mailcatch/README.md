<!-- https://github.com/SeanDishman/openai-account-generator -->
# mailcatch

A **wildcard catch-all mail server**. It accepts email sent to *any* address at
your domain (`literally-anything@yourdomain.com`), shows every message on a live
web page, and exposes a JSON API — including "the latest notification and the
timestamp it was received".

No mailboxes to configure. No auth. Point a domain's MX record at it and every
mail to that domain lands in the inbox UI.

```
   Internet ──SMTP:25──►  mailcatch (Node)  ──stores──►  in-memory + data/emails.json
                                │
   Browser  ──HTTP:80/443──► nginx ──► 127.0.0.1:3000 ──► web UI + JSON API
```

---

## What you get

| Piece | Where |
|-------|-------|
| SMTP catch-all server | port **25** (accepts mail for any recipient, no auth) |
| Web UI (live inbox) | `http://yourdomain/` |
| Latest notification + timestamp | `GET /api/latest` |
| All messages (summaries) | `GET /api/emails` (optional `?to=` filter, `?limit=`) |
| One full message | `GET /api/emails/:id` |
| Clear the inbox | `DELETE /api/emails` |
| Health check | `GET /healthz` |

### `GET /api/latest` response

```json
{
  "email": {
    "id": "fd69e7a8cea5fd48f9",
    "receivedAt": "2026-07-02T14:08:58.547Z",
    "from": "\"Some Bank\" <alerts@somebank.test>",
    "to": "literally-anything@example.com",
    "envelopeTo": ["literally-anything@example.com"],
    "subject": "Your verification code is 483920",
    "text": "…",
    "html": "…"
  },
  "receivedAt": "2026-07-02T14:08:58.547Z",
  "count": 1
}
```

`receivedAt` is exactly when the SMTP server accepted the message.

---

## Authentication

The web UI and the API are protected by a single password. It lives **only on the
backend** (`AUTH_PASSWORD` in `server.js`) and is never sent to the browser — the
frontend just has a login box that POSTs the password to the server.

- **Web UI:** visiting the site shows a login screen; enter the password to view
  the inbox. A successful login sets an `httpOnly` session cookie.
- **API (programmatic):** send the password in a header — either works:
  ```bash
  curl -H "X-Api-Key: YOUR_PASSWORD" https://mail.example.com/api/latest
  curl -H "Authorization: Bearer YOUR_PASSWORD" https://mail.example.com/api/emails
  ```
  Without a valid cookie or header, every `/api/*` endpoint returns `401`.
- `GET /healthz` stays open (no data) for uptime checks.

Change the password with the `AUTH_PASSWORD` env var (in the systemd unit) or by
editing the default in `server.js`, then `systemctl restart mailcatch`.

---

## Deploy to the VPS (146.19.248.208)

### 1. Copy the app up and run the deploy script

From your laptop (Git Bash / WSL / macOS / Linux):

```bash
scp -r mailcatch root@146.19.248.208:/root/
ssh root@146.19.248.208
cd /root/mailcatch
sudo bash deploy.sh mail.example.com        # <- your real domain
```

The script installs Node + nginx + certbot, runs mailcatch as a systemd service
(allowed to bind port 25), reverse-proxies the web UI, opens the firewall, and
requests a TLS certificate.

Options:

```bash
sudo bash deploy.sh                          # IP-only, no domain, no TLS
sudo ENABLE_TLS=0 bash deploy.sh mail.example.com          # domain, skip cert for now
sudo LETSENCRYPT_EMAIL=you@gmail.com bash deploy.sh mail.example.com
```

### 2. Point your domain at the server (DNS)

Do the DNS **before** (or right after) deploying so certbot can validate. See the
Namecheap section below.

### 3. Manage it

```bash
systemctl status mailcatch
journalctl -u mailcatch -f     # watch incoming mail live
systemctl restart mailcatch
```

---

## DNS records — Namecheap

Say your domain is **`example.com`** and you want to receive mail as
`anything@example.com`.

1. Namecheap → **Domain List** → **Manage** (next to your domain) → **Advanced DNS** tab.
2. **IMPORTANT — set the mail mode:** find the **Mail Settings** dropdown (top of
   the *Mail Settings* / Host Records area) and set it to **Custom MX**.
   If it's left on *Email Forwarding* or *Private Email*, Namecheap ignores your
   MX record and mail never reaches your server. This is the #1 mistake.
3. **Delete the default parking records** Namecheap adds: the **URL Redirect
   Record** on host `@` and the `CNAME` `www → parkingpage.namecheap.com`. They
   conflict with the records below.
4. Add these **Host Records**:

| Type | Host | Value | Priority | TTL |
|------|------|-------|----------|-----|
| **A Record**  | `@`    | `146.19.248.208` | — | Automatic |
| **A Record**  | `mail` | `146.19.248.208` | — | Automatic |
| **MX Record** | `@`    | `mail.example.com` | `10` | Automatic |

What each one does:
- **A `@`** → `example.com` (and your web UI) resolves to the server.
- **A `mail`** → `mail.example.com` resolves to the server; this is the mail host.
- **MX `@`** → mail addressed to `…@example.com` is delivered to `mail.example.com`
  (which the A record above points at the server). MX **must** be a hostname, not
  an IP — that's why we point it at `mail.example.com`, not at the raw IP.

> Deploying with `sudo bash deploy.sh mail.example.com`? Then use **`mail.example.com`**
> as the domain so TLS + the web UI are on `mail.example.com`, and the table above
> makes `anything@example.com` deliver to it. If you'd rather the web UI live on
> the bare `example.com`, deploy with `example.com` instead — either works.

**Optional but recommended — reverse DNS (PTR).** In your VPS provider's control
panel, set reverse DNS for `146.19.248.208` → `mail.example.com`. Strict senders
(Gmail) are more likely to accept delivery when forward and reverse DNS match.

**You do NOT need SPF/DKIM/DMARC.** Those are for *sending* mail. mailcatch only
*receives*, so skip them.

### Verify DNS + delivery

Wait 15–30 min for propagation, then:

```bash
dig +short MX example.com          # -> 10 mail.example.com.
dig +short A  mail.example.com      # -> 146.19.248.208

# send a test (install swaks: apt-get install swaks)
swaks --to hello@example.com --server mail.example.com
```

Then open `http://example.com/` (or `https://mail.example.com/`) and watch it appear,
or `curl http://example.com/api/latest`.

---

## Heads-up: port 25

Many cloud/VPS providers **block port 25 by default** — usually *outbound*, but
some block *inbound* too. mailcatch needs **inbound 25** open. If test mail never
arrives, confirm with your provider that inbound 25 is allowed for your VPS (and
that no upstream firewall is dropping it). Outbound 25 doesn't matter here — we
never send.

## Run locally (dev)

```bash
cd mailcatch
npm install
HTTP_PORT=3000 SMTP_PORT=2525 node server.js
# in another terminal, fire a test message in:
node test-send.js
# then open http://localhost:3000 (log in with the password)
# or hit the API with the password header:
#   curl -H "X-Api-Key: change-me" http://localhost:3000/api/latest
```

Port 25 needs root locally; use `SMTP_PORT=2525` for dev.

## Config (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `AUTH_PASSWORD` | `change-me` | password for web login + API |
| `SESSION_TTL_MS` | `2592000000` | login session lifetime (30 days) |
| `HTTP_PORT` | `3000` | web UI + API port |
| `HTTP_HOST` | `0.0.0.0` | (deploy sets `127.0.0.1`; Caddy/nginx fronts it) |
| `SMTP_PORT` | `25` | SMTP listen port |
| `SMTP_HOST` | `0.0.0.0` | SMTP bind address |
| `MAX_EMAILS` | `500` | ring-buffer size (oldest dropped) |
| `MAX_SIZE` | `26214400` | max message size (25 MB) |
| `DATA_FILE` | `./data/emails.json` | on-disk persistence |
