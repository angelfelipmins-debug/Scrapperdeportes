const RAILWAY_BASE = "https://TU_RAILWAY_URL"; // reemplaza
const CACHE_SECONDS = 30;

addEventListener("fetch", (event) => {
  event.respondWith(handle(event.request));
});

const memCache = new Map();

async function readCache(key) {
  try {
    if (typeof caches !== "undefined" && caches.default) {
      const r = await caches.default.match(key);
      if (r) return await r.json();
    }
  } catch(e){}
  const v = memCache.get(key);
  if (v && (Date.now() - v._ts)/1000 < CACHE_SECONDS) return v.data;
  return null;
}
async function writeCache(key, data) {
  try {
    if (typeof caches !== "undefined" && caches.default) {
      const body = JSON.stringify(data);
      const headers = { "Content-Type": "application/json" };
      const resp = new Response(body, { headers });
      await caches.default.put(key, resp);
      return;
    }
  } catch(e){}
  memCache.set(key, { _ts: Date.now(), data });
}

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/matches") {
    const q = url.search;
    const cacheKey = `/matches${q}`;
    const cached = await readCache(cacheKey);
    if (cached) return new Response(JSON.stringify(cached, null, 2), { headers: { "Content-Type":"application/json"}});
    const r = await fetch(`${RAILWAY_BASE}/api/matches${q}`, { headers: { "x-api-key": request.headers.get("x-api-key")||"" }});
    const data = await r.json();
    await writeCache(cacheKey, data);
    return new Response(JSON.stringify(data, null,2), { headers: { "Content-Type":"application/json"}});
  }

  if (path === "/api/streams") {
    const target = url.searchParams.get("url");
    const matchId = url.searchParams.get("match_id") || "";
    if (!target) return new Response(JSON.stringify({ error: "url query param required" }), { status: 400, headers:{ "Content-Type":"application/json"}});
    const cacheKey = `/streams?u=${encodeURIComponent(target)}`;
    const cached = await readCache(cacheKey);
    if (cached) return new Response(JSON.stringify(cached, null,2), { headers:{ "Content-Type":"application/json"}});
    const r = await fetch(`${RAILWAY_BASE}/api/streams?match_id=${encodeURIComponent(matchId)}&url=${encodeURIComponent(target)}`, { headers: { "x-api-key": request.headers.get("x-api-key")||"" }});
    const data = await r.json();
    await writeCache(cacheKey, data);
    return new Response(JSON.stringify(data, null,2), { headers:{ "Content-Type":"application/json"}});
  }

  if (path === "/api/unified") {
    const matchUrl = url.searchParams.get("match_url");
    const matchId = url.searchParams.get("match_id");
    const league = url.searchParams.get("league");
    if (!matchUrl && !matchId && !league) return new Response(JSON.stringify({ error: "provide match_url or match_id or league" }), { status: 400, headers:{ "Content-Type":"application/json"}});
    let matchInfo = null;
    if (league) {
      const r = await fetch(`${RAILWAY_BASE}/api/matches?league=${encodeURIComponent(league)}`, { headers: { "x-api-key": request.headers.get("x-api-key")||"" }});
      const jd = await r.json().catch(()=>null);
      if (jd && jd.matches && matchId) matchInfo = jd.matches.find(m=>String(m.id)===String(matchId));
    }
    const r2 = await fetch(`${RAILWAY_BASE}/api/streams?match_id=${encodeURIComponent(matchId||"")}&url=${encodeURIComponent(matchUrl||"")}`, { headers: { "x-api-key": request.headers.get("x-api-key")||"" }});
    const streams = await r2.json().catch(()=>({streams:[]}));
    const out = { match: matchInfo, streams: streams.streams || [], cached: streams.cached || false };
    return new Response(JSON.stringify(out, null,2), { headers:{ "Content-Type":"application/json"}});
  }

  return new Response("OK - edge proxy", { headers: { "Content-Type":"text/plain" }});
}
