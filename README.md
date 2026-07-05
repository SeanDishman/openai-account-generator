<!-- https://github.com/SeanDishman/openai-account-generator -->
# OpenAI Account Generator

A Firefox extension that automates the OpenAI (ChatGPT) sign-up flow on
`auth.openai.com` end to end — it fills a random name, email, and password,
reads the emailed verification code, and completes phone verification with a
rented number. It routes OpenAI traffic through per-account rotating proxies,
verifies the proxy on start, and clears cookies between runs.

> **Repo:** https://github.com/SeanDishman/openai-account-generator
>
> ⚠️ **Use responsibly.** Automating account creation may violate OpenAI's Terms
> of Service. This project is provided for education and authorized testing only.
> You are responsible for how you use it.

---

## How it works

```
                proxy (OpenAI domains only)
   ┌────────────────────────────┐
   │  Firefox + this extension  │──►  auth.openai.com   (signup automation)
   └────────────┬───────────────┘
                │ poll for the verification code (HTTPS + API key)
                ▼
        ┌───────────────┐        MX / port 25
        │   mailcatch    │◄───────────────────────  OpenAI's verification email
        │  (your server) │      (anything@yourdomain)
        └───────────────┘
                ▲
                │ rent a US number + read the SMS code
        ┌───────────────┐
        │    SMSPool     │   (paid 3rd-party SMS API)
        └───────────────┘
```

There are **three pieces you must provide**:

1. **mailcatch** (included) — a tiny catch-all mail server you host on a domain.
   OpenAI emails the verification code to `something@yourdomain`; mailcatch
   receives it and exposes it over a JSON API the extension polls.
2. **An SMSPool account** ([smspool.net](https://smspool.net)) — a paid service
   that rents phone numbers for the SMS step. You need an API key + balance.
3. **Proxies** — your own HTTP/SOCKS proxies. They're applied **only** to OpenAI
   domains, one per account, rotated after each signup.

---

## Repository layout

```
extension/           the Firefox extension (load this in about:debugging)
  manifest.json      permissions + config
  background.js      proxy routing, cookie clearing, mailcatch + SMSPool calls
  content.js         the on-page automation + hacker-style debug console
  popup.js/.html     toolbar popup: on/off toggle + current proxy
  proxys.txt         YOUR proxy list (template included — add your own)
mailcatch/           the catch-all mail server (Node.js)
  server.js          SMTP + HTTP/JSON API
  deploy.sh          one-shot VPS installer (Caddy/nginx + systemd + TLS)
  README.md          mailcatch-specific docs
```

---

## Setup

### Prerequisites
- **Firefox** (this extension targets Firefox; it uses APIs Chrome lacks).
- **A Linux VPS + a domain** you control (for mailcatch). Any $5 VPS works.
- **An SMSPool account** with API key and balance.
- **Proxies** (HTTP or SOCKS5). Residential/ISP proxies work best for OpenAI.

---

### Step 1 — Deploy mailcatch (the mail server)

mailcatch receives the OpenAI verification emails. It needs to be the mail
server (MX) for a domain you own.

1. **Point DNS at your server:**
   - An **A record** for e.g. `mail.yourdomain.com` → your VPS IP.
   - An **MX record** for `mail.yourdomain.com` → `mail.yourdomain.com` (priority 10).
   - Make sure your VPS provider/firewall allows **inbound port 25**.

2. **Deploy** on the VPS:
   ```bash
   git clone https://github.com/SeanDishman/openai-account-generator
   cd openai-account-generator/mailcatch
   sudo AUTH_PASSWORD='pick-a-strong-password' bash deploy.sh mail.yourdomain.com
   ```
   `deploy.sh` installs Node, sets up a reverse proxy (Caddy/nginx) with
   automatic HTTPS, and runs mailcatch as a systemd service. See
   [`mailcatch/README.md`](mailcatch/README.md) for details and manual setup.

3. **Verify** it's up: open `https://mail.yourdomain.com` — you should get a
   login box. Log in with the `AUTH_PASSWORD` you chose.

> Prefer to run it locally to try things out? `cd mailcatch && npm install &&
> AUTH_PASSWORD=change-me node server.js` then use
> `node test-send.js` to inject a fake email. (Real OpenAI mail still needs a
> public server with port 25 + MX.)

---

### Step 2 — Get an SMSPool API key

1. Create an account at [smspool.net](https://smspool.net) and add balance.
2. Copy your API key from **Settings → API**.
3. The extension is preset to service **671 (OpenAI/ChatGPT)**, country **1 (US)** —
   change `SMSPOOL_SERVICE` / `SMSPOOL_COUNTRY` in `background.js` if needed.

---

### Step 3 — Add your proxies

Edit [`extension/proxys.txt`](extension/proxys.txt), one proxy per line:

```
# host:port:username:password   (user:pass optional)
123.45.67.89:8080:myuser:mypass
98.76.54.32:1080
socks5://11.22.33.44:1080:myuser:mypass
```

- Applied **only** to OpenAI domains — the rest of your browsing is untouched.
- One random proxy is bound per account and **rotated 15s after each signup**.
- If the list is empty the extension **fails closed** (OpenAI won't load) so your
  real IP is never used.

---

### Step 4 — Configure the extension

Edit these to match your mailcatch domain + keys:

| File | Setting | Set to |
|------|---------|--------|
| `extension/background.js` | `API_BASE` | `https://mail.yourdomain.com` |
| `extension/background.js` | `API_KEY` | the mailcatch `AUTH_PASSWORD` from Step 1 |
| `extension/background.js` | `SMSPOOL_API_KEY` | your SMSPool key from Step 2 |
| `extension/content.js` | `MAIL_DOMAIN` | `mail.yourdomain.com` |
| `extension/manifest.json` | `host_permissions` | replace `https://mail.example.com/*` with `https://mail.yourdomain.com/*` |

> `API_KEY` (extension) **must equal** `AUTH_PASSWORD` (mailcatch) — that's how
> the extension authenticates to the mail API.

---

### Step 5 — Load the extension in Firefox

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**
3. Select `extension/manifest.json`.
4. Firefox will prompt for the `proxy`, `cookies`, and host permissions — accept.

The extension icon appears in the toolbar. (Temporary add-ons are removed on
Firefox restart — reload them the same way, or package/sign for permanence.)

---

## Usage

1. Click the extension's **toolbar icon** → a small popup opens.
   - **Enabled** toggle — master on/off (off = normal browsing, no proxy, no automation).
   - **proxy** — the proxy this session is using.
   - **Open signup tab** — clears OpenAI cookies and opens a fresh `auth.openai.com`.
2. On the signup page an on-page **debug console** appears (top-right) showing
   every step. At the top you'll see:
   ```
   [PROXY] connected to proxy 1.2.3.4:8080 (37 in pool)
   [PROXY] verified ✓ — OpenAI sees exit IP 1.2.3.4
   ```
3. The extension runs the whole flow automatically: **Sign up → email → password
   → email code → phone (SMS) → name + age → Finish**.
4. **15 seconds after the final button**, the background clears all OpenAI cookies
   and rotates to a new proxy — so it's safe to close the tab, and the next
   account starts clean on a fresh IP.

Repeat: click **Open signup tab** again for the next account.

### What it handles for you
- **Random identity** — big first/last-name pools and varied email shapes
  (some with numbers, some without), all `@yourdomain`.
- **Proxy verification** — confirms OpenAI actually sees the proxy IP, not yours.
- **WhatsApp-only numbers** — if a rented number offers only WhatsApp (no SMS),
  it refunds the number and rents a new one (never uses WhatsApp). Capped at 5
  tries so it can't drain your SMSPool balance.
- **Cookie hygiene** — wipes `openai.com` / `chatgpt.com` cookies (incl.
  `sentinel.openai.com` Cloudflare cookies) after each account.

---

## Configuration reference

**`extension/background.js`**
| Const | Meaning |
|-------|---------|
| `API_BASE` | mailcatch server URL |
| `API_KEY` | mailcatch password (= `AUTH_PASSWORD`) |
| `SMSPOOL_API_KEY` | SMSPool API key |
| `SMSPOOL_SERVICE` | SMSPool service id (`671` = OpenAI) |
| `SMSPOOL_COUNTRY` | SMSPool country id (`1` = US) |

**`mailcatch/server.js`** (override with env vars)
| Var | Default | Meaning |
|-----|---------|---------|
| `AUTH_PASSWORD` | `change-me` | web login + API password |
| `HTTP_PORT` | `3000` | web UI / API port |
| `SMTP_PORT` | `25` | inbound mail port |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `[PROXY] verification FAILED` | Proxy is dead/blocked, or the tool is disabled. Try **Rotate proxy now** or check `proxys.txt`. |
| `no proxies loaded` | `proxys.txt` is empty or all comments — add real proxies. |
| Verification code never arrives | Check DNS MX + inbound port 25; hit `https://mail.yourdomain.com/api/latest` with your API key; confirm `API_BASE`/`MAIL_DOMAIN` match. |
| `SMSPool API key not set` | Set `SMSPOOL_API_KEY` in `background.js`. |
| Pages won't load at all with the tool on | That's **fail-closed** — every proxy is unreachable. Fix your proxies or toggle the tool off. |
| Cookies not cleared | They clear 15s after the final signup button; if you keep a completed tab open, Cloudflare can re-set them — close the tab. |

---

## Tech notes
- Firefox MV3 event-page background; proxying via `proxy.onRequest` (OpenAI URLs
  only) with credentials supplied through `webRequest.onAuthRequired`.
- Requires Firefox because Chrome has no equivalent dynamic per-request proxy API.

## License
See [LICENSE](LICENSE).
