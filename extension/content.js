// https://github.com/SeanDishman/openai-account-generator
// Automates OpenAI sign-up flow on auth.openai.com and shows a hacker-style
// on-page debug console (black + neon green; red errors, yellow warnings,
// green successes). Logs damn near everything.
//
// Flow (each step reacts to whatever input is currently on the page, so it works
// whether OpenAI navigates via SPA or full page loads):
//   1. /log-in                 -> wait 1-3s, click "Sign up".
//   2. email field             -> wait 1-2s, type random email, click Continue.
//   3. new-password field      -> wait 1-3s, focus, wait 0.5-1s, type random
//                                 12-14 char password, wait 0.3-1s, click Continue.
//   4. code field (name=code)  -> wait 10s, focus, poll mailcatch API for the
//                                 verification code, human-type it.

(() => {
  "use strict";

  // ----------------------------- utils -----------------------------
  const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (s) => s[rand(0, s.length - 1)];
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rand(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  const ts = () => {
    const d = new Date();
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(
      d.getMilliseconds(),
      3
    )}`;
  };

  // ------------------- hacker-style debug overlay -------------------
  const COLORS = {
    info: "#00ff66",
    ok: "#39ff14",
    warn: "#ffe500",
    err: "#ff2b3d",
    dbg: "#28c7c7",
    net: "#b36bff",
  };

  const Panel = (() => {
    let box, body, count = 0;
    const MAX_LINES = 800;

    function build() {
      if (box || !document.body) return;
      box = document.createElement("div");
      Object.assign(box.style, {
        position: "fixed",
        top: "12px",
        right: "12px",
        width: "760px",
        maxWidth: "94vw",
        maxHeight: "34vh",
        display: "flex",
        flexDirection: "column",
        background: "#000000",
        border: "1px solid #000000",
        borderRadius: "6px",
        boxShadow: "0 0 6px rgba(0,0,0,0.7)",
        color: "#00ff66",
        font: "12px/1.45 'Consolas','SFMono-Regular',Menlo,monospace",
        zIndex: "2147483647",
        overflow: "hidden",
        textShadow: "none",
      });

      const header = document.createElement("div");
      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "6px 10px",
        background: "linear-gradient(90deg,#001a0d,#003b1e)",
        borderBottom: "1px solid #00ff66",
        letterSpacing: "1px",
        fontWeight: "700",
        cursor: "default",
        userSelect: "none",
      });
      const title = document.createElement("span");
      title.textContent = "OPENAI AUTO-SIGNUP";
      const matrix = document.createElement("span");
      Object.assign(matrix.style, {
        marginLeft: "12px",
        color: "#00ff66",
        opacity: "0.85",
        letterSpacing: "3px",
        fontWeight: "400",
      });
      const left = document.createElement("span");
      Object.assign(left.style, { display: "flex", alignItems: "center" });
      left.appendChild(title);
      left.appendChild(matrix);
      const btns = document.createElement("span");

      const mkBtn = (label, fn) => {
        const b = document.createElement("span");
        b.textContent = label;
        Object.assign(b.style, {
          cursor: "pointer",
          padding: "0 6px",
          color: "#00ff66",
        });
        b.addEventListener("click", fn);
        return b;
      };
      const clearBtn = mkBtn("[clr]", () => {
        body.textContent = "";
        count = 0;
      });
      const hideBtn = mkBtn("[x]", () => {
        body.style.display = body.style.display === "none" ? "block" : "none";
      });
      btns.appendChild(clearBtn);
      btns.appendChild(hideBtn);
      header.appendChild(left);
      header.appendChild(btns);

      body = document.createElement("div");
      Object.assign(body.style, {
        padding: "8px 10px",
        overflowY: "auto",
        overflowX: "hidden",
        flex: "1",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      });

      box.appendChild(header);
      box.appendChild(body);
      document.body.appendChild(box);

      // matrix-rain flavored ticker to the right of the title
      const KATA =
        "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0110";
      const randKata = (n) => {
        let s = "";
        for (let i = 0; i < n; i++) s += KATA[Math.floor(Math.random() * KATA.length)];
        return s;
      };
      matrix.textContent = randKata(10);
      setInterval(() => (matrix.textContent = randKata(10)), 130);
    }

    function line(level, msg) {
      // Always mirror to the real console too.
      const con =
        level === "err" ? console.error : level === "warn" ? console.warn : console.log;
      con(`[auto-signup ${level}]`, msg);

      if (!box) build();
      if (!body) return;

      const row = document.createElement("div");
      const t = document.createElement("span");
      t.textContent = ts() + "  ";
      t.style.color = "#0a7d3f";
      const m = document.createElement("span");
      m.textContent = msg;
      m.style.color = COLORS[level] || COLORS.info;
      if (level === "err") m.style.fontWeight = "700";
      row.appendChild(t);
      row.appendChild(m);
      body.appendChild(row);

      if (++count > MAX_LINES && body.firstChild) body.removeChild(body.firstChild);
      body.scrollTop = body.scrollHeight;
    }

    return { line, build };
  })();

  const fmt = (a) =>
    a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  const log = (...a) => Panel.line("info", fmt(a));
  const ok = (...a) => Panel.line("ok", "✔ " + fmt(a));
  const warn = (...a) => Panel.line("warn", "[!] " + fmt(a));
  const err = (...a) => Panel.line("err", "[X] " + fmt(a));
  const dbg = (...a) => Panel.line("dbg", "· " + fmt(a));
  const net = (...a) => Panel.line("net", "⇄ " + fmt(a));

  // Surface uncaught errors in the overlay.
  window.addEventListener("error", (e) =>
    err("window error:", e.message + " @ " + (e.filename || "") + ":" + e.lineno)
  );
  window.addEventListener("unhandledrejection", (e) =>
    err("unhandled rejection:", String(e.reason))
  );

  // ----------------------------- page helpers -----------------------------
  const isPath = (p) =>
    location.hostname === "auth.openai.com" &&
    location.pathname.replace(/\/+$/, "") === p;

  function waitFor(fn, label, timeout = 15000, interval = 150) {
    return new Promise((resolve) => {
      const initial = fn();
      if (initial) return resolve(initial);
      dbg(`waiting for ${label} (timeout ${timeout}ms)…`);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearInterval(poll);
        clearTimeout(cap);
        resolve(v);
      };
      const check = () => {
        const v = fn();
        if (v) finish(v);
      };
      const obs = new MutationObserver(check);
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const poll = setInterval(check, interval);
      const cap = setTimeout(() => finish(null), timeout);
    });
  }

  // ----------------------------- finders -----------------------------
  const findSignupLink = () =>
    document.querySelector('a[href="/create-account"]') ||
    document.querySelector('a[href*="create-account"]') ||
    [...document.querySelectorAll('a, button, [role="button"]')].find(
      (a) => a.textContent.trim().toLowerCase() === "sign up"
    ) ||
    null;

  // The "Your session has ended" interstitial only offers a "Log in" button.
  // Clicking it starts a fresh auth transaction that leads to the email / Sign-up
  // screen the rest of the flow expects.
  const findLoginButton = () =>
    [...document.querySelectorAll('button, a, [role="button"]')].find((el) => {
      const t = (el.textContent || "").trim().toLowerCase();
      return t === "log in" || t === "login" || t === "sign in";
    }) || null;

  const findEmailInput = () =>
    document.querySelector('input[type="email"]') ||
    document.querySelector('input[name="email"]') ||
    document.querySelector('input[autocomplete="email"]') ||
    document.querySelector('input[placeholder="Email address" i]') ||
    [...document.querySelectorAll("input")].find((i) =>
      (i.getAttribute("aria-label") || "").toLowerCase().includes("email")
    ) ||
    null;

  const findPasswordInput = () =>
    document.querySelector('input[type="password"][name="new-password"]') ||
    document.querySelector('input[type="password"]') ||
    null;

  const findCodeInput = () =>
    document.querySelector('input[name="code"]') ||
    document.querySelector('input[autocomplete="one-time-code"]') ||
    document.querySelector('input[inputmode="numeric"][maxlength="6"]') ||
    null;

  const findPhoneInput = () =>
    document.querySelector('input[name="__reservedForPhoneNumberInput_tel"]') ||
    document.querySelector("#tel") ||
    document.querySelector('input[type="tel"]') ||
    document.querySelector('input[autocomplete="tel"]') ||
    null;

  const findSmsRadio = () =>
    document.querySelector('input[type="radio"][value="sms"]') || null;

  // The delivery-method screen may offer WhatsApp. We must NEVER use WhatsApp, so
  // this is only used to DETECT a WhatsApp-only number (refund + get a new one).
  const findWhatsappRadio = () =>
    document.querySelector('input[type="radio"][value="whatsapp"]') ||
    [...document.querySelectorAll('input[type="radio"]')].find((r) =>
      /whats\s*app/i.test(r.value || "")
    ) ||
    null;

  const findContinueButton = () => {
    const submits = [...document.querySelectorAll('button[type="submit"]')];
    return (
      submits.find((b) => b.textContent.trim().toLowerCase() === "continue") ||
      submits.find((b) => b.textContent.trim().toLowerCase().includes("continue")) ||
      submits[0] ||
      null
    );
  };

  // Find the <input> belonging to a typeable field by its visible label text
  // (e.g. "Full name", "Age") — via the label's `for=`, its field container,
  // or a placeholder/aria-label fallback.
  const findLabeledInput = (labelText) => {
    const want = labelText.trim().toLowerCase();
    for (const lab of document.querySelectorAll("label")) {
      if (lab.textContent.trim().toLowerCase() !== want) continue;
      const forId = lab.getAttribute("for");
      if (forId) {
        const byId = document.getElementById(forId);
        if (byId && byId.tagName === "INPUT") return byId;
      }
      const container = lab.closest('div[class*="_fieldFootprint"]') || lab.parentElement;
      const inp = container && container.querySelector("input");
      if (inp) return inp;
    }
    return (
      document.querySelector(`input[placeholder="${labelText}" i]`) ||
      [...document.querySelectorAll("input")].find(
        (i) => (i.getAttribute("aria-label") || "").trim().toLowerCase() === want
      ) ||
      null
    );
  };

  // Find a button by its visible text (submit-type preferred).
  const findButtonByText = (text) => {
    const want = text.trim().toLowerCase();
    const btns = [...document.querySelectorAll('button[type="submit"], button')];
    return (
      btns.find((b) => b.textContent.trim().toLowerCase() === want) ||
      btns.find((b) => b.textContent.trim().toLowerCase().includes(want)) ||
      null
    );
  };

  // ----------------------------- random values -----------------------------
  // Word pool for email local-parts.
  const WORDS = [
    "apple", "river", "stone", "cloud", "tiger", "maple", "ocean", "ember",
    "frost", "willow", "cobalt", "meadow", "silver", "crimson", "pixel",
    "nova", "quartz", "raven", "lunar", "delta", "harbor", "cedar", "onyx",
    "amber", "ridge", "spark", "violet", "hazel", "orbit", "clover", "aspen",
    "birch", "canyon", "dune", "echo", "fern", "glade", "grove", "heron",
    "indigo", "jade", "kestrel", "lark", "lotus", "marble", "nimbus", "opal",
    "pine", "quill", "ripple", "sable", "thorn", "umber", "vale", "zephyr",
    "arrow", "brook", "coral", "drift", "flint", "garnet", "hollow", "isle",
    "juniper", "kelp", "lagoon", "mist", "north", "otter", "prairie", "reef",
    "sage", "tide", "vapor", "wren", "cinder", "dusk", "elm", "forge", "gale",
    "haven", "iris", "jasper", "lynx", "moss", "nectar", "pebble", "rowan",
    "slate", "timber", "vine", "wharf", "basil", "comet", "hawk", "lily", "oak",
    "storm", "breeze", "cove", "fable", "moor", "quest", "solstice", "tundra",
    "ash", "bloom", "dawn", "flare", "grain", "meadowlark", "quartzite",
  ];

  // Name pools -> "First Last" (mixed male/female).
  const FIRST_NAMES = [
    "James", "Michael", "Robert", "John", "David", "William", "Richard",
    "Joseph", "Thomas", "Mark", "Steven", "Andrew", "Kevin", "Brian", "George",
    "Roger", "Ethan", "Ryan", "Jacob", "Nathan", "Aaron", "Adam", "Justin",
    "Sean", "Eric", "Daniel", "Matthew", "Anthony", "Peter", "Paul", "Charles",
    "Christopher", "Benjamin", "Samuel", "Gregory", "Patrick", "Jack", "Dylan",
    "Luke", "Henry", "Owen", "Caleb", "Isaac", "Gabriel", "Julian", "Wyatt",
    "Carter", "Jordan", "Cameron", "Tyler", "Nicholas", "Evan", "Cole", "Miles",
    "Mary", "Jennifer", "Linda", "Patricia", "Elizabeth", "Susan", "Jessica",
    "Sarah", "Karen", "Emily", "Emma", "Olivia", "Ava", "Sophia", "Isabella",
    "Mia", "Charlotte", "Amelia", "Harper", "Evelyn", "Abigail", "Ella",
    "Grace", "Chloe", "Victoria", "Lily", "Hannah", "Zoe", "Natalie", "Nora",
    "Aria", "Scarlett", "Layla", "Riley", "Aubrey", "Claire", "Stella",
  ];
  const LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
    "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
    "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "Martin",
    "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark",
    "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Allen", "King",
    "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green", "Adams",
    "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter",
    "Roberts", "Gomez", "Phillips", "Evans", "Turner", "Diaz", "Parker",
    "Cruz", "Edwards", "Collins", "Reyes", "Stewart", "Morris", "Morales",
    "Murphy", "Cook", "Rogers", "Gutierrez", "Ortiz", "Morgan", "Cooper",
    "Peterson", "Bailey", "Reed", "Kelly", "Howard", "Ramos", "Kim", "Cox",
    "Ward", "Richardson", "Watson", "Brooks", "Bennett", "Gray", "Price",
    "Bell", "Wood", "Barnes", "Ross", "Henderson", "Coleman", "Jenkins",
    "Perry", "Powell", "Long", "Patterson", "Hughes", "Foster", "Sanders",
  ];

  // CONFIGURE: your mailcatch domain — must match API_BASE in background.js and
  // host_permissions in manifest.json (see README "Setup").
  const MAIL_DOMAIN = "mail.example.com";

  // Random email on the catch-all domain. Varied shapes — several have NO number.
  const genEmail = () => {
    const w = () => WORDS[rand(0, WORDS.length - 1)];
    const fn = () => FIRST_NAMES[rand(0, FIRST_NAMES.length - 1)].toLowerCase();
    const ln = () => LAST_NAMES[rand(0, LAST_NAMES.length - 1)].toLowerCase();
    const num = () => String(rand(2, 9999));
    const sep = () => pick(["", "", "", "", ".", "_"]); // usually no separator
    // ~1/3 have no number; the no-number ones use 3 tokens (or first.last) to keep
    // collisions rare, since a duplicate email makes OpenAI reject the signup.
    const shapes = [
      () => `${w()}${w()}${num()}`,
      () => `${w()}${sep()}${w()}${num()}`,
      () => `${w()}${num()}`,
      () => `${fn()}${sep()}${ln()}${num()}`,
      () => `${fn()}${w()}${num()}`,
      () => `${w()}${w()}${w()}`, // no number, 3 tokens
      () => `${fn()}${sep()}${ln()}`, // no number, realistic first.last
      () => `${fn()}${ln()}${w()}`, // no number, 3 tokens
    ];
    return `${pick(shapes)()}@${MAIL_DOMAIN}`;
  };

  const genFullName = () =>
    `${FIRST_NAMES[rand(0, FIRST_NAMES.length - 1)]} ${LAST_NAMES[rand(0, LAST_NAMES.length - 1)]}`;
  const genAge = () => String(rand(20, 40));

  // Pick a real birthday for someone aged 20-50. We choose a random calendar day
  // between (today - 50y) and (today - 20y), so the month/day are always valid and
  // the resulting age is guaranteed to land in [20, 50].
  const genBirthday = () => {
    const now = new Date();
    const youngest = new Date(now.getFullYear() - 20, now.getMonth(), now.getDate()); // age 20
    const oldest = new Date(now.getFullYear() - 50, now.getMonth(), now.getDate()); // age 50
    const t = oldest.getTime() + Math.floor(Math.random() * (youngest.getTime() - oldest.getTime() + 1));
    const d = new Date(t);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  };

  const genPassword = () => {
    const lower = "abcdefghijkmnpqrstuvwxyz";
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const nums = "23456789";
    const syms = "!@#$%^&*?-_";
    const all = lower + upper + nums + syms;
    const len = rand(12, 14);
    const chars = [pick(lower), pick(upper), pick(nums), pick(syms)];
    while (chars.length < len) chars.push(pick(all));
    return shuffle(chars).join("");
  };

  // ----------------------------- human typing -----------------------------
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  ).set;
  const setValue = (el, value) => nativeInputValueSetter.call(el, value);

  async function humanType(el, text, label) {
    dbg(`typing into ${label}: "${text}" (${text.length} chars)`);
    el.focus();
    el.click();
    setValue(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));

    let acc = "";
    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      acc += ch;
      setValue(el, acc);
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" })
      );
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(rand(30, 90));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    ok(`${label} filled -> current value: "${el.value}"`);
  }

  // ---- React-Aria segmented date field (the OpenAI "Birthday" input) ----
  // OpenAI renders the birthday as a React-Aria Components DateField: three
  // contenteditable <div role="spinbutton"> segments (month/day/year), NOT a plain
  // <input>. It ships pre-filled with today's date, so setValue()/humanType() do
  // nothing here — the segments only react to keyboard + `beforeinput` events.

  // Locate the three segments by their data-type (order-independent).
  const findDateSegments = () => {
    const seg = (type) =>
      document.querySelector(`[role="spinbutton"][data-type="${type}"]`) ||
      document.querySelector(`[contenteditable="true"][data-type="${type}"]`);
    const month = seg("month");
    const day = seg("day");
    const year = seg("year");
    return month && day && year ? { month, day, year } : null;
  };

  // Clear one segment (Backspace until empty), then type its zero-padded digits.
  // React-Aria consumes a cancelable `beforeinput` InputEvent for entry
  // (insertText); we pair each digit with the matching keydown/keyup so it looks
  // like real typing.
  async function typeDateSegment(seg, digits, label) {
    seg.focus();
    seg.click();
    await sleep(rand(90, 180));

    // Wipe whatever's pre-filled (today's date) — "hit delete till no numbers".
    // React-Aria handles Backspace in its keydown handler, so a bare keydown clears
    // the segment. We deliberately do NOT send a `deleteContentBackward` beforeinput
    // here: older React-Aria builds do `enteredKeys + e.data` and would inject the
    // literal string "null". (Typing below also overwrites a focused segment, so
    // this loop is belt-and-suspenders to satisfy "delete till empty".)
    for (let i = 0; i < 6; i++) {
      seg.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", keyCode: 8, which: 8, bubbles: true, cancelable: true }));
      seg.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", code: "Backspace", keyCode: 8, which: 8, bubbles: true }));
      await sleep(rand(25, 65));
    }

    // type the value one digit at a time (zero-padded so single-digit months/days
    // commit immediately instead of waiting for a possible second digit)
    for (const ch of String(digits)) {
      const kc = 48 + Number(ch);
      seg.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code: "Digit" + ch, keyCode: kc, which: kc, bubbles: true, cancelable: true }));
      seg.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true, cancelable: true }));
      seg.dispatchEvent(new KeyboardEvent("keyup", { key: ch, code: "Digit" + ch, keyCode: kc, which: kc, bubbles: true }));
      await sleep(rand(60, 130));
    }
    dbg(`[BIRTHDAY] ${label} segment -> "${digits}" (shows "${(seg.textContent || "").trim()}")`);
  }

  // Fill the birthday date field for a random 20-50 y/o. Returns true if the field
  // was found and filled, false if there's no date field on the page (caller then
  // falls back to the legacy "Age" input).
  async function fillBirthday() {
    const segs = await waitFor(findDateSegments, "birthday date field", 8000);
    if (!segs) return false;

    const b = genBirthday();
    const mm = String(b.month).padStart(2, "0");
    const dd = String(b.day).padStart(2, "0");
    const yyyy = String(b.year);
    log(`[BIRTHDAY] entering ${mm}/${dd}/${yyyy} (age ${new Date().getFullYear() - b.year})`);

    await typeDateSegment(segs.month, mm, "month");
    await sleep(rand(120, 260));
    await typeDateSegment(segs.day, dd, "day");
    await sleep(rand(120, 260));
    await typeDateSegment(segs.year, yyyy, "year");

    ok(`[BIRTHDAY] filled -> ${mm}/${dd}/${yyyy}`);
    return true;
  }

  // ------------------- background / mailcatch messaging -------------------
  const store = (() => {
    try {
      return chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    } catch (e) {
      return null;
    }
  })();

  const getStoredEmail = () =>
    new Promise((resolve) => {
      if (!store) return resolve(null);
      try {
        store.get("usedEmail", (r) => resolve(r && r.usedEmail));
      } catch (e) {
        resolve(null);
      }
    });

  const storeSet = (obj) => {
    if (!store) return;
    try {
      store.set(obj);
    } catch (e) {
      /* storage optional */
    }
  };
  const storeGet = (keys) =>
    new Promise((resolve) => {
      if (!store) return resolve({});
      try {
        store.get(keys, (r) => resolve(r || {}));
      } catch (e) {
        resolve({});
      }
    });

  // Robust sendMessage: works with Chrome's callback style AND Firefox's promise.
  function send(msg) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      try {
        const ret = chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            done({ error: chrome.runtime.lastError.message });
            return;
          }
          done(resp || {});
        });
        if (ret && typeof ret.then === "function") {
          ret.then((resp) => done(resp || {}), (e) => done({ error: String(e) }));
        }
      } catch (e) {
        done({ error: String(e) });
      }
    });
  }

  async function pingBackground() {
    net("pinging background script…");
    const r = await send({ type: "ping" });
    if (r && r.ok) ok("background alive (pong @ " + r.ts + ")");
    else err("background NOT responding:", r && r.error ? r.error : "no response");
    return r && r.ok;
  }

  async function pollForCode(email, timeoutMs = 120000) {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      attempt++;
      net(`API poll #${attempt} -> code for ${email || "(any)"}`);
      const resp = await send({ type: "getCode", email });
      if (resp && resp.error) {
        err("API error:", resp.error);
      } else if (resp && resp.code) {
        ok(`code received: ${resp.code}  (subject: "${resp.subject}", to: ${resp.to})`);
        return resp.code;
      } else {
        dbg(
          `no code yet (matched: ${resp && resp.subject ? '"' + resp.subject + '"' : "none"})`
        );
      }
      await sleep(2500);
    }
    return null;
  }

  // ----------------------------- steps -----------------------------
  const PHONE = {
    maxAttempts: 5, // safety cap so retries can't drain your SMSPool balance
    smsWaitMs: 10000, // wait 10s for the SMS code before refunding + retrying
    addPhoneUrl: "https://auth.openai.com/add-phone",
  };

  let signupDone = false;
  let emailDone = false;
  let passwordDone = false;
  let codeDone = false;
  let phoneDone = false;
  let profileDone = false;
  let usedEmail = null;
  let resuming = false; // guards the "session ended" -> Log in click

  // "Your session has ended" interstitial: click Log in to start a fresh auth
  // transaction, then wait until the real flow (Sign-up link or email field)
  // appears so the dispatcher can take over.
  async function doResumeStep() {
    if (resuming) return;
    resuming = true;
    try {
      const btn = findLoginButton();
      if (!btn) return;
      const d = rand(800, 1800);
      log(`[RESUME] "session ended" page detected. waiting ${d}ms then clicking Log in`);
      await sleep(d);
      btn.click();
      ok("[RESUME] Log in clicked — starting auth flow");
      await waitFor(
        () => findSignupLink() || findEmailInput(),
        "auth flow to start after Log in",
        15000
      );
    } finally {
      resuming = false;
    }
  }

  async function doSignupStep() {
    signupDone = true;
    storeSet({ phoneAttempts: 0 }); // fresh run -> reset the phone retry counter
    const d = rand(1000, 3000);
    log(`[SIGNUP] log-in page detected. waiting ${d}ms then clicking Sign up`);
    await sleep(d);
    const link = await waitFor(findSignupLink, "Sign up link");
    if (link) {
      log(`[SIGNUP] clicking Sign up (href=${link.getAttribute("href")})`);
      link.click();
      ok("[SIGNUP] Sign up clicked");
    } else {
      err("[SIGNUP] Sign up link not found");
    }
  }

  async function doEmailStep() {
    emailDone = true;
    const d = rand(1000, 2000);
    log(`[EMAIL] email field detected. waiting ${d}ms`);
    await sleep(d);
    const input = findEmailInput();
    if (!input) return err("[EMAIL] email input vanished");

    const email = genEmail();
    usedEmail = email;
    if (store) {
      try {
        store.set({ usedEmail: email, usedAt: Date.now() });
        dbg("[EMAIL] stored email for later code lookup");
      } catch (e) {
        warn("[EMAIL] could not persist email:", String(e));
      }
    }
    await humanType(input, email, "email");

    const btn = await waitFor(findContinueButton, "Continue button", 10000);
    if (btn) {
      log("[EMAIL] clicking Continue");
      btn.click();
      ok("[EMAIL] Continue clicked");
    } else {
      err("[EMAIL] Continue button not found");
    }
  }

  async function doPasswordStep() {
    passwordDone = true;
    const input = findPasswordInput();
    if (!input) return err("[PASS] password input vanished");

    const d = rand(1000, 3000);
    log(`[PASS] password field detected. waiting ${d}ms then focusing`);
    await sleep(d);
    input.focus();
    input.click();

    const d2 = rand(500, 1000);
    dbg(`[PASS] focused. waiting ${d2}ms before typing`);
    await sleep(d2);
    const pw = genPassword();
    await humanType(input, pw, "password");

    const d3 = rand(300, 1000);
    dbg(`[PASS] waiting ${d3}ms before Continue`);
    await sleep(d3);
    const btn = await waitFor(findContinueButton, "Continue button", 10000);
    if (btn) {
      log("[PASS] clicking Continue");
      btn.click();
      ok("[PASS] Continue clicked");
    } else {
      err("[PASS] Continue button not found");
    }
  }

  async function doCodeStep() {
    codeDone = true;
    const input = findCodeInput();
    if (!input) return err("[CODE] code input vanished");

    log("[CODE] code field detected. waiting 10s before entering code");
    await sleep(10000);
    input.focus();
    input.click();
    dbg("[CODE] code field focused");

    const email = usedEmail || (await getStoredEmail());
    log(`[CODE] fetching verification code for ${email || "(unknown address)"}`);
    const code = await pollForCode(email);
    if (!code) return err("[CODE] verification code not retrieved (timed out)");

    await humanType(input, code, "code");
    ok("[CODE] verification code entered");

    await sleep(rand(500, 1200));
    const btn = await waitFor(findContinueButton, "Continue button (code)", 10000);
    if (btn) {
      log("[CODE] clicking Continue");
      btn.click();
      ok("[CODE] Continue clicked");
    } else {
      err("[CODE] Continue button not found");
    }
  }

  // ---- phone verification via a rented SMSPool number ----

  async function pollSms(orderId, timeoutMs) {
    const start = Date.now();
    let n = 0;
    while (Date.now() - start < timeoutMs) {
      n++;
      net(`[PHONE] SMS check #${n} (order ${orderId})`);
      const r = await send({ type: "smsCheck", orderId });
      if (r && r.error) {
        err(`[PHONE] check error: ${r.error}`);
      } else if (r && r.code) {
        return r.code;
      } else if (r && [2, 5, 6].indexOf(r.status) !== -1) {
        warn(`[PHONE] order reached terminal status ${r.status} (2=expired,5=cancelled,6=refunded)`);
        return null;
      } else {
        dbg(`[PHONE] no code yet (status ${r ? r.status : "?"})`);
      }
      await sleep(2000);
    }
    return null;
  }

  async function refundAndRetry(orderId, attemptNo, reason) {
    warn(`[PHONE] ${reason} — refunding number & retrying`);
    if (orderId) {
      const c = await send({ type: "smsCancel", orderId });
      if (c && c.ok) ok(`[PHONE] number refunded: ${c.message || "ok"}`);
      else warn(`[PHONE] refund result: ${(c && (c.message || c.error)) || "unknown"}`);
    }
    storeSet({ phoneAttempts: attemptNo }); // persist across the upcoming reload
    if (attemptNo >= PHONE.maxAttempts) {
      return err(`[PHONE] reached max attempts (${PHONE.maxAttempts}) — not retrying further`);
    }
    await sleep(rand(1200, 2200));
    log("[PHONE] navigating back to /add-phone for a fresh number");
    location.href = PHONE.addPhoneUrl;
  }

  async function doPhoneStep() {
    phoneDone = true;

    const { phoneAttempts = 0 } = await storeGet("phoneAttempts");
    if (phoneAttempts >= PHONE.maxAttempts) {
      return err(
        `[PHONE] already at max attempts (${PHONE.maxAttempts}) — stopping so it can't keep renting numbers. Restart the flow to reset.`
      );
    }
    const attemptNo = phoneAttempts + 1;
    log(`[PHONE] attempt ${attemptNo}/${PHONE.maxAttempts}: renting a US number for OpenAI (service 671)…`);

    // 1) rent a number
    const rent = await send({ type: "smsRent" });
    if (!rent || rent.error || !rent.ok) {
      // rent failed (no balance / out of stock / key not set) — don't loop-burn; stop.
      return err(`[PHONE] rent failed: ${(rent && rent.error) || "unknown"}`);
    }
    net(`[PHONE] rented ${rent.number} (national ${rent.national}, order ${rent.orderId}, cost $${rent.cost})`);
    storeSet({ phoneOrderId: rent.orderId, phoneNumber: rent.number });

    // 2) type the national number into the phone field
    const phoneInput = findPhoneInput();
    if (!phoneInput) return refundAndRetry(rent.orderId, attemptNo, "phone input vanished");
    await sleep(rand(600, 1200));
    await humanType(phoneInput, rent.national, "phone");

    // 3) Continue -> advances to the delivery-method screen
    await sleep(rand(700, 1500));
    let btn = await waitFor(findContinueButton, "Continue (phone)", 10000);
    if (!btn) return refundAndRetry(rent.orderId, attemptNo, "Continue (phone) not found");
    log("[PHONE] clicking Continue (phone)");
    btn.click();
    ok("[PHONE] phone number submitted");

    // 4) pick the SMS delivery method. Some US numbers only offer WhatsApp — we
    //    must NOT use WhatsApp, so in that case refund the number and try a new one.
    await sleep(rand(800, 1600));
    await waitFor(
      () => findSmsRadio() || findWhatsappRadio(),
      "delivery-method options",
      10000
    );
    const radio = findSmsRadio();
    if (radio) {
      log("[PHONE] selecting SMS delivery");
      radio.click();
      ok("[PHONE] SMS method selected");
    } else if (findWhatsappRadio()) {
      // WhatsApp-only number — refund it and grab a fresh number. Never use WhatsApp.
      return refundAndRetry(
        rent.orderId,
        attemptNo,
        "number only offers WhatsApp (no SMS)"
      );
    } else {
      warn("[PHONE] no delivery radios found (SMS may be the default) — continuing");
    }

    // 5) Continue -> tells OpenAI to send the SMS
    await sleep(rand(700, 1500));
    btn = await waitFor(findContinueButton, "Continue (send SMS)", 10000);
    if (!btn) return refundAndRetry(rent.orderId, attemptNo, "Continue (send SMS) not found");
    log("[PHONE] clicking Continue (send SMS)");
    btn.click();
    ok("[PHONE] SMS requested from OpenAI");

    // 6) wait up to 10s for the SMS code
    log(`[PHONE] waiting up to ${PHONE.smsWaitMs / 1000}s for the SMS code…`);
    const code = await pollSms(rent.orderId, PHONE.smsWaitMs);
    if (!code) return refundAndRetry(rent.orderId, attemptNo, "no SMS code in time");

    // 7) success — enter the code
    ok(`[PHONE] SMS code received: ${code}`);
    storeSet({ phoneAttempts: 0 }); // success -> reset the counter
    const otp = await waitFor(findCodeInput, "phone OTP field", 15000);
    if (otp) {
      await sleep(rand(500, 1000));
      await humanType(otp, code, "phone-otp");
      await sleep(rand(500, 1200));
      const cbtn = await waitFor(findContinueButton, "Continue (phone OTP)", 10000);
      if (cbtn) {
        log("[PHONE] clicking Continue (OTP)");
        cbtn.click();
        ok("[PHONE] phone verification submitted");
      } else {
        warn("[PHONE] OTP Continue button not found");
      }
    } else {
      warn(`[PHONE] no OTP field found — enter ${code} manually`);
    }
  }

  // ---- final profile step: Full name + Age -> Finish -> Continue ----
  async function doProfileStep() {
    profileDone = true;
    log("[PROFILE] profile page detected (Full name / Age)");

    // Full name
    await sleep(rand(300, 1000)); // wait 0.3-1s
    const nameInput = findLabeledInput("Full name");
    if (!nameInput) return err("[PROFILE] Full name field not found");
    const fullName = genFullName();
    await humanType(nameInput, fullName, "full name");

    // Birthday — OpenAI replaced the old "Age" input with a segmented date field.
    // Fill that for a random 20-50 y/o; fall back to a legacy "Age" input if some
    // flow still shows it.
    await sleep(rand(300, 1000)); // wait 0.3-1s
    const filledBirthday = await fillBirthday();
    if (!filledBirthday) {
      const ageInput = findLabeledInput("Age");
      if (!ageInput) return err("[PROFILE] neither Birthday date field nor Age field found");
      warn("[PROFILE] no birthday date field — falling back to legacy Age input");
      await humanType(ageInput, genAge(), "age");
    }

    // Finish creating account
    await sleep(rand(500, 1200)); // wait 0.5-1.2s
    const finishBtn = await waitFor(
      () => findButtonByText("Finish creating account"),
      "Finish creating account button",
      10000
    );
    if (finishBtn) {
      log("[PROFILE] clicking Finish creating account");
      finishBtn.click();
      ok("[PROFILE] Finish creating account clicked");
    } else {
      return err("[PROFILE] Finish creating account button not found");
    }

    // Final Continue — wait for it to appear, then click.
    const contBtn = await waitFor(
      () => findButtonByText("Continue"),
      "final Continue button",
      20000
    );
    if (contBtn) {
      await sleep(rand(400, 1000));
      log("[PROFILE] clicking final Continue");
      contBtn.click();
      ok("[PROFILE] final Continue clicked — account setup complete");

      // Hand off to the background: it clears the OpenAI cookies + rotates the
      // proxy 15s from now. Running it in the BACKGROUND means it still happens
      // even if you close this tab right after the final click.
      const r = await send({ type: "accountDone" });
      if (r && r.scheduled)
        ok("[DONE] account created — background clears cookies + rotates proxy in 15s (safe to close tab)");
      else
        warn(`[DONE] could not schedule cleanup: ${(r && (r.error || JSON.stringify(r))) || "no response"}`);
    } else {
      err("[PROFILE] final Continue button did not appear");
    }
  }

  // ------------------- page-reactive dispatcher -------------------
  async function dispatch() {
    log("dispatcher running on " + location.href);
    // Keep reacting to whatever page/step is currently showing.
    for (;;) {
      try {
        if (!signupDone && findSignupLink()) {
          await doSignupStep();
        } else if (
          !emailDone &&
          findEmailInput() &&
          !findPasswordInput() &&
          !findCodeInput()
        ) {
          await doEmailStep();
        } else if (!passwordDone && findPasswordInput()) {
          await doPasswordStep();
        } else if (!codeDone && findCodeInput() && !findPhoneInput()) {
          await doCodeStep();
        } else if (!phoneDone && findPhoneInput()) {
          await doPhoneStep();
        } else if (!profileDone && findLabeledInput("Full name")) {
          await doProfileStep();
        } else if (
          // Last resort: "Your session has ended" interstitial (only a Log in
          // button, no Sign-up link or email field yet) — click through it.
          !findSignupLink() &&
          !findEmailInput() &&
          !findPasswordInput() &&
          !findCodeInput() &&
          findLoginButton()
        ) {
          await doResumeStep();
        }
      } catch (e) {
        err("step threw:", String(e));
      }
      await sleep(500);
    }
  }

  // Line 1: which proxy this session is on. Line 2: verify the proxy actually
  // carries OpenAI traffic (the background fetches auth.openai.com/cdn-cgi/trace
  // THROUGH the proxy and reads back the exit IP OpenAI sees). Verify runs once
  // per tab so page navigations don't re-fetch it.
  async function showAndVerifyProxy() {
    const pr = await send({ type: "getCurrentProxy" });
    if (pr && pr.noProxy) {
      return warn("[PROXY] NO-PROXY mode ON — OpenAI traffic uses your REAL IP (verification skipped)");
    }
    if (pr && pr.proxy) ok(`[PROXY] connected to proxy ${pr.proxy} (${pr.count} in pool)`);
    else return warn(`[PROXY] no proxy set — check proxys.txt (${(pr && pr.count) || 0} loaded)`);

    let done = false;
    try {
      done = sessionStorage.getItem("__oai_proxy_verified") === "1";
    } catch (e) {
      /* ignore */
    }
    if (done) return dbg("[PROXY] connection already verified for this tab");

    net("[PROXY] verifying connection through the proxy…");
    const vr = await send({ type: "verifyProxy" });
    if (vr && vr.ok) {
      ok(`[PROXY] verified ✓ — OpenAI sees exit IP ${vr.ip}`);
      try {
        sessionStorage.setItem("__oai_proxy_verified", "1");
      } catch (e) {
        /* ignore */
      }
    } else {
      err(`[PROXY] verification FAILED: ${(vr && vr.error) || "no response"}`);
    }
  }

  // ----------------------------- boot -----------------------------
  async function boot() {
    Panel.build();
    ok("extension loaded");
    log("url:", location.href);
    log("path:", location.pathname);
    log("userAgent:", navigator.userAgent);

    // Master on/off — set from the extension popup. When off, do nothing.
    const st = await storeGet("enabled");
    if (st && st.enabled === false) {
      warn("[INIT] tool is DISABLED — toggle it on from the extension popup");
      return;
    }

    // NOTE: cookies are NOT cleared at boot anymore — they are cleared 15s after
    // the final button of the PREVIOUS account (see doProfileStep), so each flow
    // starts clean without a mid-page reload.
    await pingBackground();
    // Show + verify the proxy in the panel (fire-and-forget so a slow/dead proxy
    // can't stall the signup flow).
    showAndVerifyProxy();
    dispatch();
  }
  boot();
})();
