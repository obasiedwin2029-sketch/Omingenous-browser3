const express = require("express");
const puppeteer = require("puppeteer-core");

const TOKEN = process.env.TOKEN || "";
const PORT = Number(process.env.PORT || 7860);
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable";
const SIZES = { phone: [390, 760], tablet: [768, 900], desktop: [1280, 800] };

const app = express();
app.use(express.json({ limit: "1mb" }));

let browser = null;
const sessions = new Map();

const MARK_JS = () => {
  document.querySelectorAll("[data-omg]").forEach((e) => e.removeAttribute("data-omg"));
  const sel = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[onclick]";
  const out = [];
  let n = 0;
  const labels = {};
  document.querySelectorAll("label[for]").forEach((l) => {
    labels[l.getAttribute("for")] = (l.textContent || "").trim().slice(0, 60);
  });
  for (const e of document.querySelectorAll(sel)) {
    if (n >= 120) break;
    const r = e.getBoundingClientRect();
    const st = getComputedStyle(e);
    if (st.visibility === "hidden" || st.display === "none" || r.width < 2 || r.height < 2) continue;
    if (r.bottom < -400 || r.top > innerHeight + 1600) continue;
    const type = (e.getAttribute("type") || "").toLowerCase();
    if (type === "hidden") continue;
    n++;
    e.setAttribute("data-omg", String(n));
    const tag = e.tagName.toLowerCase();
    let kind = tag;
    if (tag === "a") kind = "link";
    else if (tag === "button" || tag === "summary" || type === "submit" || type === "button" || e.getAttribute("role") === "button") kind = "button";
    else if (tag === "input") kind = type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : "input";
    let text = (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text) text = (e.getAttribute("aria-label") || e.getAttribute("title") || e.getAttribute("value") || e.getAttribute("alt") || "").slice(0, 80);
    if (!text && e.id && labels[e.id]) text = labels[e.id];
    const options = tag === "select" ? Array.from(e.options).slice(0, 12).map((o) => (o.text || o.value).slice(0, 40)) : [];
    out.push({
      id: n,
      tag: kind,
      type: type,
      text: text,
      name: e.getAttribute("name") || "",
      href: tag === "a" ? e.href : "",
      placeholder: (e.getAttribute("placeholder") || "").slice(0, 60),
      options: options,
      checked: !!e.checked,
    });
  }
  return { elements: out, text: (document.body ? document.body.innerText : "").slice(0, 6000) };
};

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-features=site-per-process,IsolateOrigins,TranslateUI",
        "--disable-site-isolation-trials",
        "--disable-breakpad",
        "--disable-component-update",
        "--renderer-process-limit=1",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--mute-audio",
        "--no-first-run",
        "--js-flags=--max-old-space-size=256",
      ],
    });
  }
  return browser;
}

// Free hosting has about 512 MB of memory, so only one browser tab lives at a time.
async function dropAll(except) {
  for (const [k, v] of sessions) {
    if (k === except) continue;
    try {
      await v.page.close();
    } catch (e) {}
    sessions.delete(k);
  }
}

// After 5 quiet minutes the whole browser is closed to give the memory back.
setInterval(async () => {
  const now = Date.now();
  let idle = true;
  for (const v of sessions.values()) if (now - v.last < 300000) idle = false;
  if (idle && browser) {
    await dropAll("");
    try {
      await browser.close();
    } catch (e) {}
    browser = null;
  }
}, 60000);

async function getSession(sid, device) {
  const now = Date.now();
  await dropAll(sid);
  let s = sessions.get(sid);
  if (s && s.device !== device) {
    const size = SIZES[device] || SIZES.phone;
    await s.page.setViewport({ width: size[0], height: size[1], isMobile: device === "phone", hasTouch: device !== "desktop" });
    s.device = device;
  }
  if (!s) {
    const b = await getBrowser();
    const page = await b.newPage();
    const size = SIZES[device] || SIZES.phone;
    await page.setViewport({ width: size[0], height: size[1], isMobile: device === "phone", hasTouch: device !== "desktop" });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const t = r.resourceType();
      if (t === "media" || t === "font") r.abort().catch(() => undefined);
      else r.continue().catch(() => undefined);
    });
    s = { page: page, device: device, last: now, busy: Promise.resolve() };
    sessions.set(sid, s);
  }
  s.last = now;
  return s;
}

async function settle(page) {
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 });
  } catch (e) {}
  // JavaScript apps draw themselves a moment after loading: wait until there is something on the page.
  for (let i = 0; i < 8; i++) {
    let len = 0;
    try {
      len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0));
    } catch (e) {}
    if (len >= 40) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  await new Promise((r) => setTimeout(r, 400));
}

async function perform(s, req) {
  const page = s.page;
  let cursor = null;
  let note = "";
  try {
    if (req.action === "open") {
      await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await settle(page);
    } else if (req.action === "click" || req.action === "type" || req.action === "press") {
      const el = await page.$('[data-omg="' + Number(req.id) + '"]');
      if (!el) {
        note = "failed: element " + req.id + " not found";
      } else {
        await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
        const box = await el.boundingBox();
        if (box) cursor = { x: box.x + Math.min(box.width / 2, 120), y: box.y + Math.min(box.height / 2, 30) };
        if (req.action === "click") {
          await el.click();
          await settle(page);
        } else if (req.action === "type") {
          const tag = await el.evaluate((e) => e.tagName.toLowerCase());
          if (tag === "select") {
            await el.evaluate((e, want) => {
              const w = String(want).toLowerCase();
              for (let i = 0; i < e.options.length; i++) {
                const o = e.options[i];
                if (o.value.toLowerCase() === w || o.text.toLowerCase().indexOf(w) !== -1) {
                  e.selectedIndex = i;
                  break;
                }
              }
              e.dispatchEvent(new Event("input", { bubbles: true }));
              e.dispatchEvent(new Event("change", { bubbles: true }));
            }, req.text || "");
          } else {
            await el.click({ clickCount: 3 });
            await page.keyboard.press("Backspace");
            await page.keyboard.type(req.text || "", { delay: 25 });
          }
        } else {
          await el.focus();
          await page.keyboard.press(req.text || "Enter");
          await settle(page);
        }
      }
    } else if (req.action === "click_xy") {
      cursor = { x: req.x, y: req.y };
      await page.mouse.click(req.x, req.y);
      await settle(page);
    } else if (req.action === "type_text") {
      await page.keyboard.type(req.text || "", { delay: 20 });
    } else if (req.action === "key") {
      await page.keyboard.press(req.text);
      await settle(page);
    } else if (req.action === "scroll") {
      await page.mouse.wheel({ deltaY: req.text === "up" ? -600 : 600 });
      await new Promise((r) => setTimeout(r, 500));
    } else if (req.action === "back") {
      await page.goBack({ timeout: 8000 });
      await settle(page);
    } else if (req.action === "wait") {
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) {
    note = "failed: " + String(e && e.message ? e.message : e).split("\n")[0].slice(0, 200);
  }
  let info = { elements: [], text: "" };
  try {
    info = await page.evaluate(MARK_JS);
  } catch (e) {}
  let shot = "";
  try {
    shot = await page.screenshot({ type: "jpeg", quality: 55, encoding: "base64" });
  } catch (e) {}
  let title = "";
  try {
    title = await page.title();
  } catch (e) {}
  const size = SIZES[req.device] || SIZES.phone;
  return { url: page.url(), title: title, shot: shot, width: size[0], height: size[1], cursor: cursor, note: note, elements: info.elements, text: info.text };
}

app.get("/", (req, res) => res.json({ ok: true }));

app.post("/do", async (req, res) => {
  if (!TOKEN || req.get("x-token") !== TOKEN) return res.status(401).json({ detail: "bad token" });
  const body = req.body || {};
  if (!body.sid) return res.status(400).json({ detail: "sid required" });
  try {
    const s = await getSession(String(body.sid), body.device || "phone");
    const run = s.busy.then(() => perform(s, body));
    s.busy = run.catch(() => undefined);
    res.json(await run);
  } catch (e) {
    res.status(500).json({ detail: String(e && e.message ? e.message : e).slice(0, 300) });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log("browser server on " + PORT));
