// https://github.com/SeanDishman/openai-account-generator
// Popup logic. Extension pages block inline scripts (CSP), so this lives in its
// own file. Talks to background.js over runtime messages.

const BX = typeof browser !== "undefined" ? browser : chrome;

const $toggle = document.getElementById("toggle");
const $proxy = document.getElementById("proxy");
const $pool = document.getElementById("pool");

// Robust sendMessage that works with both Firefox (promise) and Chrome (callback).
function send(msg) {
  return new Promise((resolve) => {
    try {
      const ret = BX.runtime.sendMessage(msg, (resp) => resolve(resp || {}));
      if (ret && typeof ret.then === "function") {
        ret.then((resp) => resolve(resp || {}), () => resolve({}));
      }
    } catch (e) {
      resolve({});
    }
  });
}

// Show the current OpenAI proxy + how many are in the pool.
async function showProxy() {
  const r = await send({ type: "getCurrentProxy" });
  if (r && r.proxy) {
    $proxy.textContent = r.proxy;
    $pool.textContent = `${r.count} loaded`;
  } else if (r && r.count === 0) {
    $proxy.textContent = "none";
    $pool.textContent = "0 — check proxys.txt";
  } else {
    $proxy.textContent = "none";
    $pool.textContent = r && r.count ? `${r.count} loaded` : "—";
  }
}

async function refresh() {
  // enabled state (default ON)
  try {
    const st = await BX.storage.local.get("enabled");
    $toggle.checked = st.enabled !== false;
  } catch (e) {
    $toggle.checked = true;
  }
  await showProxy();
}

$toggle.addEventListener("change", async () => {
  try {
    await BX.storage.local.set({ enabled: $toggle.checked });
  } catch (e) {
    /* ignore */
  }
});

document.getElementById("openTab").addEventListener("click", async () => {
  await send({ type: "openSignupTab" });
  window.close();
});

document.getElementById("rotate").addEventListener("click", async () => {
  $proxy.textContent = "rotating…";
  const r = await send({ type: "rotateProxy" });
  if (r && r.proxy) $proxy.textContent = r.proxy;
  else $proxy.textContent = (r && r.error) || "failed";
});

refresh();
