// https://github.com/SeanDishman/openai-account-generator
// Popup logic. Extension pages block inline scripts (CSP), so this lives in its
// own file. Talks to background.js over runtime messages.

const BX = typeof browser !== "undefined" ? browser : chrome;

const $toggle = document.getElementById("toggle");
const $noproxy = document.getElementById("noproxy");
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
  if (r && r.noProxy) {
    // no-proxy mode: traffic uses the real IP regardless of the pool
    $proxy.textContent = "disabled (real IP)";
    $pool.textContent = r.count ? `${r.count} loaded` : "—";
    return;
  }
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
  // enabled state (default ON) + no-proxy state (default OFF)
  try {
    const st = await BX.storage.local.get(["enabled", "noProxy"]);
    $toggle.checked = st.enabled !== false;
    $noproxy.checked = st.noProxy === true;
  } catch (e) {
    $toggle.checked = true;
    $noproxy.checked = false;
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

$noproxy.addEventListener("change", async () => {
  try {
    await BX.storage.local.set({ noProxy: $noproxy.checked });
  } catch (e) {
    /* ignore */
  }
  await showProxy(); // reflect real-IP / proxy label immediately
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
