// https://github.com/SeanDishman/openai-account-generator
// Background script: fetches the ChatGPT verification code from the mailcatch API.
// Runs in the extension's privileged context, so with host_permissions for
// mail.example.com it can hit the API cross-origin without CORS getting in the way
// (the content script on auth.openai.com can't do that directly).

// ===== CONFIGURE (see README "Setup") =====================================
// API_BASE : the URL of YOUR mailcatch server (the domain that receives the
//            OpenAI verification emails). Also update host_permissions in
//            manifest.json and MAIL_DOMAIN in content.js to the same domain.
// API_KEY  : must equal AUTH_PASSWORD in mailcatch/server.js.
const API_BASE = "https://mail.example.com";
const API_KEY = "change-me";
// ==========================================================================

// ===== SMSPool (rent a US phone number for OpenAI phone verification) =====
// >>> SET YOUR SMSPOOL API KEY HERE (from https://smspool.net/my/settings) <<<
const SMSPOOL_API_KEY = "PUT_YOUR_SMSPOOL_API_KEY_HERE";
const SMSPOOL_BASE = "https://api.smspool.net";
const SMSPOOL_SERVICE = "671"; // OpenAI / ChatGPT
const SMSPOOL_COUNTRY = "1"; // United States

// ============================================================================
// OpenAI-only proxy + master on/off toggle + OpenAI cookie clearing
// ----------------------------------------------------------------------------
// - ONE random proxy from proxys.txt is applied ONLY to OpenAI domains (see
//   OPENAI_PROXY_URLS). All other browser traffic goes direct.
// - The proxy is ROTATED (new random one) when an account finishes generating —
//   the content script sends "rotateProxy" 15s after the final Continue.
// - While enabled it FAILS CLOSED: with no proxy, OpenAI requests are dropped
//   rather than sent over the real IP. When disabled, the proxy is bypassed.
// - Proxy username/password are supplied via webRequest.onAuthRequired.
//
// NOTE: uses Firefox's proxy.onRequest API (this extension targets Firefox per the
// gecko settings). Chrome has no equivalent, so proxying is a no-op there.
// ============================================================================

// browser.* (Firefox, promise-based) with a chrome.* fallback.
const BX = typeof browser !== "undefined" ? browser : chrome;

// Cookie domains wiped by clearOpenAICookies().
const COOKIE_DOMAINS = ["openai.com", "chatgpt.com"];

// Requests routed through the proxy — OpenAI domains ONLY. Everything else direct.
const OPENAI_PROXY_URLS = [
  "*://*.openai.com/*",
  "*://openai.com/*",
  "*://*.chatgpt.com/*",
  "*://chatgpt.com/*",
];

const CURRENT_PROXY_KEY = "currentProxy"; // storage.local key for the active proxy

let PROXIES = []; // [{type, host, port, user, pass, raw}]
let currentProxy = null; // the single proxy applied to OpenAI traffic
let enabledCache = true; // master on/off (mirrors storage.local "enabled")

// Parse one line of proxys.txt: "host:port:user:pass" with an optional
// "scheme://" prefix (default http). Password may itself contain ':'.
function parseProxyLine(line) {
  let s = (line || "").trim();
  if (!s || s.startsWith("#")) return null;

  let type = "http";
  const m = s.match(/^(https?|socks5?|socks4):\/\//i);
  if (m) {
    let t = m[1].toLowerCase();
    if (t === "socks5") t = "socks"; // Firefox spells socks5 as "socks"
    type = t;
    s = s.slice(m[0].length);
  }

  const parts = s.split(":");
  if (parts.length < 2) return null;
  const host = parts[0];
  const port = parseInt(parts[1], 10);
  const user = parts[2] || "";
  const pass = parts.length > 3 ? parts.slice(3).join(":") : ""; // keep ':' in pass
  if (!host || !port) return null;
  return { type, host, port, user, pass, raw: (line || "").trim() };
}

// Load and parse proxys.txt (packaged with the extension).
async function loadProxies() {
  try {
    const url = BX.runtime.getURL("proxys.txt");
    const res = await fetch(url);
    const text = await res.text();
    PROXIES = text.split(/\r?\n/).map(parseProxyLine).filter(Boolean);
    console.log(`[auto-signup bg] loaded ${PROXIES.length} proxy(ies) from proxys.txt`);
  } catch (e) {
    PROXIES = [];
    console.error("[auto-signup bg] failed to load proxys.txt:", e);
  }
}
const proxiesReady = loadProxies();

const randProxy = () =>
  PROXIES.length ? PROXIES[Math.floor(Math.random() * PROXIES.length)] : null;

// Build a Firefox proxy.onRequest ProxyInfo from one of our proxy objects.
function proxyInfoFor(p) {
  if (!p) {
    // FAIL CLOSED: never fall back to a direct connection for OpenAI — that would
    // leak the real IP. Route to a dead local address so the request just fails.
    console.warn("[auto-signup bg] no proxy available — blocking OpenAI request (fail closed)");
    return { type: "http", host: "127.0.0.1", port: 1, failoverTimeout: 1 };
  }
  const type = p.type || "http";
  const info = { type, host: p.host, port: p.port, failoverTimeout: 10 };
  if (p.user) info.username = p.user;
  if (p.pass) info.password = p.pass;
  if (type.startsWith("socks")) info.proxyDNS = true; // resolve DNS via the proxy
  return info;
}

// ---- master on/off (persisted, mirrored into enabledCache for fast reads) ----
async function loadEnabled() {
  try {
    const st = await BX.storage.local.get("enabled");
    enabledCache = st.enabled !== false; // default ON
  } catch (e) {
    /* storage optional */
  }
}
const enabledReady = loadEnabled();

if (BX.storage && BX.storage.onChanged) {
  BX.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.enabled) {
      enabledCache = changes.enabled.newValue !== false;
      console.log(`[auto-signup bg] tool ${enabledCache ? "ENABLED" : "DISABLED"}`);
    }
  });
}

// ---- the single OpenAI proxy (persisted so it survives event-page unloads) ----
async function initCurrentProxy() {
  await proxiesReady;
  if (!PROXIES.length) {
    currentProxy = null;
    return;
  }
  try {
    const got = await BX.storage.local.get(CURRENT_PROXY_KEY);
    const saved = got && got[CURRENT_PROXY_KEY];
    if (saved && saved.host && saved.port) {
      currentProxy =
        PROXIES.find((p) => p.host === saved.host && p.port === saved.port) || saved;
      return;
    }
  } catch (e) {
    /* storage optional */
  }
  currentProxy = randProxy();
  try {
    await BX.storage.local.set({ [CURRENT_PROXY_KEY]: currentProxy });
  } catch (e) {
    /* storage optional */
  }
  console.log(
    `[auto-signup bg] OpenAI proxy -> ${currentProxy.host}:${currentProxy.port} (${currentProxy.type})`
  );
}
const currentProxyReady = initCurrentProxy();

async function getCurrentProxy() {
  await currentProxyReady;
  return currentProxy;
}

// Pick a NEW random proxy (different from the current one when possible) and make
// it the OpenAI proxy. Called 15s after an account finishes generating.
async function rotateProxy() {
  await proxiesReady;
  if (!PROXIES.length) return { error: "no proxies loaded" };
  let next = randProxy();
  let guard = 0;
  while (
    PROXIES.length > 1 &&
    currentProxy &&
    next &&
    next.host === currentProxy.host &&
    next.port === currentProxy.port &&
    guard++ < 25
  ) {
    next = randProxy();
  }
  currentProxy = next;
  try {
    await BX.storage.local.set({ [CURRENT_PROXY_KEY]: currentProxy });
  } catch (e) {
    /* storage optional */
  }
  const label = currentProxy ? `${currentProxy.host}:${currentProxy.port}` : null;
  console.log(`[auto-signup bg] rotated OpenAI proxy -> ${label}`);
  return { ok: true, proxy: label, type: currentProxy ? currentProxy.type : null };
}

// ---- route ONLY OpenAI domains through the current proxy (Firefox only) ----
if (BX.proxy && BX.proxy.onRequest) {
  BX.proxy.onRequest.addListener(
    async () => {
      await currentProxyReady;
      await enabledReady;
      if (!enabledCache) return { type: "direct" }; // tool off -> direct
      return proxyInfoFor(currentProxy);
    },
    { urls: OPENAI_PROXY_URLS }
  );
  console.log("[auto-signup bg] proxy.onRequest registered for OpenAI domains");
} else {
  console.warn(
    "[auto-signup bg] browser.proxy.onRequest unavailable — proxying disabled (requires Firefox)"
  );
}

// ---- supply proxy credentials on 407 Proxy Authentication Required ----
if (BX.webRequest && BX.webRequest.onAuthRequired) {
  try {
    BX.webRequest.onAuthRequired.addListener(
      async (details) => {
        if (!details.isProxy) return {}; // leave site logins alone
        await currentProxyReady;
        await enabledReady;
        if (enabledCache && currentProxy && currentProxy.user) {
          return {
            authCredentials: {
              username: currentProxy.user,
              password: currentProxy.pass,
            },
          };
        }
        return {};
      },
      { urls: OPENAI_PROXY_URLS },
      ["blocking"]
    );
    console.log("[auto-signup bg] onAuthRequired registered for proxy auth");
  } catch (e) {
    console.error("[auto-signup bg] could not register onAuthRequired:", e);
  }
}

// Remove every cookie for the OpenAI/ChatGPT domains AND all their subdomains
// (auth.openai.com, sentinel.openai.com — including Cloudflare's __cf_bm/__cflb)
// so the next load is a fresh, logged-out session. Returns { ok, removed }.
async function clearOpenAICookies() {
  if (!BX.cookies) return { error: "cookies API unavailable" };

  // firstPartyDomain:null pulls cookies from EVERY first-party jar (needed when
  // Firefox's Total Cookie Protection / FPI partitions them). Chrome lacks the
  // field -> fall back without it.
  async function getAll(query) {
    try {
      return (await BX.cookies.getAll({ ...query, firstPartyDomain: null })) || [];
    } catch (e) {
      try {
        return (await BX.cookies.getAll(query)) || [];
      } catch (e2) {
        return [];
      }
    }
  }

  const isTarget = (c) => {
    const d = (c.domain || "").replace(/^\./, "").toLowerCase();
    return COOKIE_DOMAINS.some((t) => d === t || d.endsWith("." + t));
  };
  const keyOf = (c) =>
    `${c.storeId}|${c.domain}|${c.path}|${c.name}|${
      c.partitionKey ? JSON.stringify(c.partitionKey) : ""
    }`;

  // Collect from a broad sweep (host permissions already scope this to our
  // domains + their subdomains like sentinel.openai.com) AND a per-domain query,
  // because Firefox's `domain` filter doesn't reliably include host-only subdomain
  // cookies. Dedupe, then remove everything on an OpenAI/ChatGPT (sub)domain.
  const found = new Map();
  const collect = (list) => {
    for (const c of list) if (isTarget(c)) found.set(keyOf(c), c);
  };
  collect(await getAll({}));
  for (const domain of COOKIE_DOMAINS) collect(await getAll({ domain }));

  let removed = 0;
  for (const c of found.values()) {
    const scheme = c.secure ? "https" : "http";
    const host = c.domain.replace(/^\./, "");
    const url = `${scheme}://${host}${c.path}`;
    // Carry firstPartyDomain / partitionKey through so partitioned + FPI cookies
    // actually get removed, not just top-level ones.
    const details = { url, name: c.name, storeId: c.storeId };
    if (typeof c.firstPartyDomain === "string") details.firstPartyDomain = c.firstPartyDomain;
    if (c.partitionKey) details.partitionKey = c.partitionKey;
    try {
      await BX.cookies.remove(details);
      removed++;
    } catch (e) {
      /* best effort */
    }
  }
  console.log(`[auto-signup bg] cleared ${removed} OpenAI/ChatGPT cookie(s)`);
  return { ok: true, removed };
}

// ---- open a fresh, logged-out signup tab (triggered from the popup button). ----
async function openSignupTab() {
  await clearOpenAICookies();
  const tab = await BX.tabs.create({
    url: "https://auth.openai.com/log-in",
    active: true,
  });
  console.log(`[auto-signup bg] opened signup tab ${tab.id}`);
}

// ---- post-account cleanup, run FROM THE BACKGROUND so it survives the tab
// closing. The content script pings "accountDone" the instant the final button
// is clicked; 15s later we clear cookies + rotate the proxy regardless of whether
// the signup tab is still open. ----
let cleanupTimer = null;
function scheduleAccountCleanup() {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  console.log("[auto-signup bg] account done — clearing cookies + rotating proxy in 15s");
  cleanupTimer = setTimeout(async () => {
    cleanupTimer = null;
    try {
      const c = await clearOpenAICookies();
      console.log("[auto-signup bg] cleanup cleared", c && c.removed, "cookie(s)");
    } catch (e) {
      console.error("[auto-signup bg] cleanup clear failed:", e);
    }
    try {
      const r = await rotateProxy();
      console.log("[auto-signup bg] cleanup rotated ->", r && r.proxy);
    } catch (e) {
      console.error("[auto-signup bg] cleanup rotate failed:", e);
    }
  }, 15000);
}

// ---- verify the proxy actually carries OpenAI traffic. auth.openai.com is in the
// proxy scope, so this request goes through the current proxy; Cloudflare's
// /cdn-cgi/trace echoes ip=<exit IP> — the IP OpenAI actually sees. Success proves
// the proxy works; the returned IP is proof it isn't our real one. ----
async function verifyProxy() {
  await currentProxyReady;
  await enabledReady;
  if (!enabledCache) return { ok: false, error: "tool disabled" };
  if (!currentProxy) return { ok: false, error: "no proxy loaded" };

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch("https://auth.openai.com/cdn-cgi/trace", {
      cache: "no-store",
      signal: ctrl.signal,
    });
    const text = await res.text();
    const m = text.match(/(?:^|\n)ip=([^\n]+)/);
    const ip = m ? m[1].trim() : null;
    if (ip) return { ok: true, ip, proxy: `${currentProxy.host}:${currentProxy.port}` };
    return { ok: false, error: `no ip in trace (http ${res.status})` };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(to);
  }
}

// Pull a human-readable error out of SMSPool's two error shapes:
//   { success:0, message:"..." }  OR  { success:0, errors:[{message,param}] }
function smspoolErr(d) {
  if (d && d.message) return d.message;
  if (d && Array.isArray(d.errors) && d.errors.length) {
    return d.errors.map((e) => e.message + (e.param ? ` (${e.param})` : "")).join("; ");
  }
  return "unknown error";
}

async function smspoolGet(path, params) {
  const qs = new URLSearchParams({ key: SMSPOOL_API_KEY, ...params }).toString();
  const url = `${SMSPOOL_BASE}${path}?${qs}`;
  console.log("[auto-signup bg] SMSPOOL GET", path, JSON.stringify(params));
  let res;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (e) {
    return { _neterr: `fetch failed: ${e} (grant host permission for api.smspool.net)` };
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = { _parseerr: String(e), success: 0 };
  }
  data._http = res.status;
  return data;
}

async function smsRent() {
  if (!SMSPOOL_API_KEY || SMSPOOL_API_KEY.indexOf("PUT_YOUR") === 0) {
    return { error: "SMSPool API key not set — edit SMSPOOL_API_KEY in background.js" };
  }
  const d = await smspoolGet("/purchase/sms", {
    country: SMSPOOL_COUNTRY,
    service: SMSPOOL_SERVICE,
  });
  if (d._neterr) return { error: d._neterr };
  if (d.success === 1 && d.order_id) {
    return {
      ok: true,
      orderId: String(d.order_id),
      number: String(d.number),
      national: d.phonenumber ? String(d.phonenumber) : String(d.number),
      cc: d.cc ? String(d.cc) : "",
      cost: d.cost,
      expiresIn: d.expires_in,
    };
  }
  return { error: `rent failed (http ${d._http}): ${smspoolErr(d)}`, type: d.type };
}

async function smsCheck(orderId) {
  const d = await smspoolGet("/sms/check", { orderid: orderId });
  if (d._neterr) return { error: d._neterr };
  const status = typeof d.status === "number" ? d.status : parseInt(d.status, 10);
  const out = { status: isNaN(status) ? null : status };
  if (status === 3) {
    // Prefer the extracted `sms` code; fall back to digits in full_sms.
    let code = d.sms ? String(d.sms).trim() : "";
    if (!code && d.full_sms) {
      const m = String(d.full_sms).match(/\b(\d{4,8})\b/);
      if (m) code = m[1];
    }
    if (code) out.code = code;
    out.fullSms = d.full_sms;
  }
  return out;
}

async function smsCancel(orderId) {
  const d = await smspoolGet("/sms/cancel", { orderid: orderId });
  if (d._neterr) return { error: d._neterr };
  return { ok: d.success === 1, message: smspoolErr(d), http: d._http };
}

// The code is a standalone 6-digit number in the email body, e.g.:
//   "Enter this temporary verification code to continue:\n\n761688"
function extractCode(email) {
  const html = email && email.html ? String(email.html).replace(/<[^>]+>/g, " ") : "";
  const bodies = [email && email.text ? String(email.text) : "", html];

  for (const body of bodies) {
    // Prefer the 6 digits right after the "...continue:" phrase.
    let m = body.match(/continue:?\s*([0-9]{6})\b/i);
    if (m) return m[1];
    m = body.match(/verification code[\s\S]{0,80}?\b([0-9]{6})\b/i);
    if (m) return m[1];
  }
  // Fallback: first standalone 6-digit run in the plain-text body.
  const t = email && email.text ? String(email.text) : "";
  const m = t.match(/(?:^|\s)([0-9]{6})(?:\s|$)/);
  return m ? m[1] : null;
}

const authHeaders = { "X-Api-Key": API_KEY };

async function fetchCode(emailAddress) {
  const localPart = (emailAddress || "").split("@")[0];
  const listUrl = localPart
    ? `${API_BASE}/api/emails?to=${encodeURIComponent(localPart)}&limit=10`
    : `${API_BASE}/api/emails?limit=10`;

  console.log("[auto-signup bg] GET", listUrl);
  let listRes;
  try {
    listRes = await fetch(listUrl, { headers: authHeaders });
  } catch (e) {
    // Almost always a missing host permission or network/DNS failure.
    return { error: `fetch failed: ${e} (check host permission for mail.example.com)` };
  }
  if (!listRes.ok) return { error: `list ${listRes.status}` };
  const listData = await listRes.json();
  const emails = listData.emails || [];

  // Newest email (list is newest-first) that looks like an OpenAI verification.
  const match =
    emails.find(
      (e) =>
        /verification code|chatgpt|openai/i.test(e.subject || "") ||
        /openai\.com/i.test(e.from || "")
    ) || emails[0];

  if (!match) return { code: null, waiting: true };

  const fullRes = await fetch(`${API_BASE}/api/emails/${match.id}`, {
    headers: authHeaders,
  });
  if (!fullRes.ok) return { error: `full ${fullRes.status}` };
  const full = await fullRes.json();

  return {
    code: extractCode(full),
    id: match.id,
    subject: match.subject,
    from: match.from,
    to: match.to,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "ping") {
    sendResponse({ ok: true, ts: new Date().toISOString() });
    return true;
  }
  if (msg.type === "getCode") {
    fetchCode(msg.email)
      .then((r) => {
        console.log("[auto-signup bg] getCode ->", r);
        sendResponse(r);
      })
      .catch((e) => sendResponse({ error: String(e) }));
    return true; // keep the message channel open for the async response
  }
  if (msg.type === "smsRent") {
    smsRent()
      .then((r) => {
        console.log("[auto-signup bg] smsRent ->", r);
        sendResponse(r);
      })
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "smsCheck") {
    smsCheck(msg.orderId)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "smsCancel") {
    smsCancel(msg.orderId)
      .then((r) => {
        console.log("[auto-signup bg] smsCancel ->", r);
        sendResponse(r);
      })
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "clearCookies") {
    clearOpenAICookies()
      .then((r) => {
        console.log("[auto-signup bg] clearCookies ->", r);
        sendResponse(r);
      })
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "openSignupTab") {
    openSignupTab()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "rotateProxy") {
    rotateProxy()
      .then((r) => {
        console.log("[auto-signup bg] rotateProxy ->", r);
        sendResponse(r);
      })
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "getCurrentProxy") {
    getCurrentProxy()
      .then((p) =>
        sendResponse({
          proxy: p ? `${p.host}:${p.port}` : null,
          type: p ? p.type : null,
          count: PROXIES.length,
          enabled: enabledCache,
        })
      )
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "verifyProxy") {
    verifyProxy()
      .then((r) => {
        console.log("[auto-signup bg] verifyProxy ->", r);
        sendResponse(r);
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "accountDone") {
    scheduleAccountCleanup();
    sendResponse({ scheduled: true });
    return true;
  }
});

console.log("[auto-signup bg] background script loaded");
