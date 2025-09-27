// server.js
const express = require("express");
const crypto = require("crypto");
const { chromium } = require("playwright");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "60", 10);
const PROXIES = process.env.PROXIES ? process.env.PROXIES.split(",").map(s=>s.trim()).filter(Boolean) : null;

let API_KEYS = new Set();
if (process.env.SECRET_API_KEYS) {
  process.env.SECRET_API_KEYS.split(",").map(k=>k.trim()).filter(Boolean).forEach(k => API_KEYS.add(k));
}
const ADMIN_KEY = process.env.SECRET_ADMIN_KEY || null;
const SIGN_SECRET = process.env.SECRET_API_KEY_FOR_SIGNATURE || null;

const cache = new Map();

function signPayload(payload, secret) {
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}
function detectLanguageFromUrl(url) {
  const s = (url || "").toLowerCase();
  if (s.includes("es") || s.includes("spa") || s.includes("lat")) return "ES";
  if (s.includes("en") || s.includes("eng")) return "EN";
  if (s.includes("pt") || s.includes("bra")) return "PT";
  if (s.includes("ar")) return "AR";
  return "UNKNOWN";
}
function extractM3u8FromText(text) {
  const re = /(https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*)/ig;
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return Array.from(out);
}

async function scrapeWithPlaywright(targetUrl, timeout = 20000) {
  const launchOptions = { args: ["--no-sandbox", "--disable-setuid-sandbox"], headless: true };
  if (PROXIES && PROXIES.length) {
    const p = PROXIES[Math.floor(Math.random() * PROXIES.length)];
    launchOptions.proxy = { server: p };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Android 10; Mobile) AppleWebKit/537.36 Chrome/112.0 Safari/537.36"
  });
  const page = await context.newPage();
  const found = new Set();

  page.on("response", async response => {
    try {
      const u = response.url();
      if (!u) return;
      if (u.includes(".m3u8")) { found.add(u); return; }
      const ct = response.headers()["content-type"] || "";
      if (ct.includes("application/json") || ct.includes("text")) {
        const body = await response.text().catch(()=>"");
        extractM3u8FromText(body).forEach(x=>found.add(x));
      }
    } catch(e){}
  });

  try { await page.goto(targetUrl, { waitUntil: "networkidle", timeout }); } catch(e){}
  try {
    const html = await page.content();
    extractM3u8FromText(html).forEach(x=>found.add(x));
    const iframeRe = /<iframe[^>]+src=["']([^"']+)["']/ig;
    let m;
    while ((m = iframeRe.exec(html)) !== null) {
      try {
        let iframeUrl = m[1];
        if (!iframeUrl.startsWith("http")) iframeUrl = new URL(iframeUrl, targetUrl).toString();
        const r = await page.request.get(iframeUrl, { timeout: 5000 }).catch(()=>null);
        if (r && r.ok) {
          const t = await r.text().catch(()=>"");
          extractM3u8FromText(t).forEach(x=>found.add(x));
        }
      } catch(e){}
    }
  } catch(e){}

  await browser.close();
  return Array.from(found);
}

function addEphemeral(url) {
  const token = Math.random().toString(36).slice(2,12) + Date.now().toString(36).slice(-6);
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}ephemeral=${token}`;
}

// Admin endpoints
app.post("/admin/add_key", (req, res) => {
  const admin = req.headers["x-admin-key"];
  if (!ADMIN_KEY || admin !== ADMIN_KEY) return res.status(403).json({ error: "admin key required" });
  const newKey = req.body && req.body.key;
  if (!newKey) return res.status(400).json({ error: "body.key required" });
  API_KEYS.add(newKey);
  return res.json({ ok: true, added: newKey });
});
app.post("/admin/remove_key", (req, res) => {
  const admin = req.headers["x-admin-key"];
  if (!ADMIN_KEY || admin !== ADMIN_KEY) return res.status(403).json({ error: "admin key required" });
  const k = req.body && req.body.key;
  if (!k) return res.status(400).json({ error: "body.key required" });
  API_KEYS.delete(k);
  return res.json({ ok: true, removed: k });
});

app.get("/health", (req, res) => res.json({ ok: true, time: Date.now() }));

// API key middleware
app.use((req, res, next) => {
  if (req.path.startsWith("/admin") || req.path === "/health") return next();
  const key = req.headers["x-api-key"] || req.query.key;
  if (!key) return res.status(401).json({ error: "x-api-key header or key query param required" });
  if (!API_KEYS.has(key)) return res.status(403).json({ error: "invalid api key" });
  req.apiKey = key;
  next();
});

// Matches (SofaScore)
app.get("/api/matches", async (req, res) => {
  try {
    const leagueId = req.query.league;
    let matches = [];
    if (req.query.live === "true") {
      const api = `https://api.sofascore.com/api/v1/sport/football/events/live`;
      const r = await fetch(api);
      const data = await r.json();
      matches = (data || []).map(ev => ({
        id: ev.id,
        league: ev.tournament?.name,
        country: ev.tournament?.category?.name,
        home: ev.homeTeam?.name,
        away: ev.awayTeam?.name,
        startTimestamp: ev.startTimestamp,
        status: ev.status?.type,
        score: `${ev.homeScore?.display || 0} - ${ev.awayScore?.display || 0}`
      }));
    } else if (leagueId) {
      const api = `https://api.sofascore.com/api/v1/unique-tournament/${leagueId}/events/next/0`;
      const r = await fetch(api);
      const data = await r.json();
      matches = (data.events || []).map(ev => ({
        id: ev.id,
        league: ev.tournament?.name,
        country: ev.tournament?.category?.name,
        home: ev.homeTeam?.name,
        away: ev.awayTeam?.name,
        startTimestamp: ev.startTimestamp,
        status: ev.status?.type,
        score: `${ev.homeScore?.display || 0} - ${ev.awayScore?.display || 0}`
      }));
    } else {
      return res.status(400).json({ error: "use ?live=true or ?league={id}" });
    }
    return res.json({ total: matches.length, matches });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Streams endpoint
app.get("/api/streams", async (req, res) => {
  try {
    const target = req.query.url;
    const matchId = req.query.match_id || null;
    if (!target) return res.status(400).json({ error: "url query param required" });

    const cacheKey = `streams::${target}`;
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached._ts)/1000 < CACHE_TTL) {
      const payload = { match_id: matchId, streams: cached.streams, cached: true };
      if (SIGN_SECRET) payload.signature = signPayload(payload, SIGN_SECRET);
      return res.json(payload);
    }

    const links = await scrapeWithPlaywright(target, 20000);
    const streams = links.map(l => ({
      url: addEphemeral(l),
      idioma: detectLanguageFromUrl(l),
      quality: (l.includes("720") || l.includes("1080") || l.includes("hd")) ? "HD" : "SD",
      source: target
    }));

    cache.set(cacheKey, { _ts: Date.now(), streams });
    const out = { match_id: matchId, streams, cached: false };
    if (SIGN_SECRET) out.signature = signPayload(out, SIGN_SECRET);
    return res.json(out);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, ()=> console.log(`Scraper Playwright running on port ${PORT}`));
