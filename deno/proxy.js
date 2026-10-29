// Proxy to ViaggiaTreno (which sends no CORS headers), the deployed counterpart of the /vt proxy
// in dev-server.mjs. Kept runtime-neutral (Request in, Response out) so it can be tested with Node.
const API = 'https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
// Only the endpoints the app uses, so this is not an open proxy.
const ENDPOINTS = new Set(['autocompletaStazione', 'partenze', 'andamentoTreno']);
// GitHub Pages serves the app on the account's custom domain (flecce.github.io redirects there).
const ALLOWED_ORIGINS = ['https://lecce.dev', 'https://flecce.github.io', 'http://localhost:8080'];

const CACHE_SECONDS = 30;
const CACHE_MAX_ENTRIES = 500;
// path+query -> { body, contentType, expires }. Only successful answers are kept.
const cache = new Map();

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function remember(key, entry) {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  // Map keeps insertion order, so the first key is the oldest.
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
}

function reply(entry, status, cors, cacheState) {
  return new Response(entry.body, {
    status,
    headers: {
      ...cors,
      'Content-Type': entry.contentType,
      'Cache-Control': status === 200 ? `public, max-age=${CACHE_SECONDS}` : 'no-store',
      'X-Cache': cacheState,
    },
  });
}

export async function handle(request) {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

  const url = new URL(request.url);
  // Keep the path encoded: the departures endpoint takes a date string with spaces.
  const rest = url.pathname.replace(/^\/vt\//, '');
  if (!ENDPOINTS.has(rest.split('/')[0])) return new Response('Unknown endpoint', { status: 404, headers: cors });

  const key = `${rest}${url.search}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return reply(hit, 200, cors, 'HIT');

  try {
    const upstream = await fetch(`${API}/${key}`, {
      headers: { 'User-Agent': 'traim/0.1 (app personale orari treni)' },
    });
    const entry = {
      body: await upstream.arrayBuffer(),
      contentType: upstream.headers.get('content-type') ?? 'text/plain',
      expires: Date.now() + CACHE_SECONDS * 1000,
    };
    if (upstream.ok) remember(key, entry);
    return reply(entry, upstream.status, cors, 'MISS');
  } catch {
    return new Response('ViaggiaTreno non raggiungibile', { status: 502, headers: cors });
  }
}
