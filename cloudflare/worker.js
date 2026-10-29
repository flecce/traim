// Cloudflare Worker: same-origin-style proxy to ViaggiaTreno (which sends no CORS headers),
// the deployed counterpart of the /vt proxy in dev-server.mjs.
const API = 'https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
// Only the endpoints the app uses, so this is not an open proxy.
const ENDPOINTS = new Set(['autocompletaStazione', 'partenze', 'andamentoTreno']);
const ALLOWED_ORIGINS = ['https://flecce.github.io', 'http://localhost:8080'];

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request) {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const url = new URL(request.url);
    // Keep the path encoded: the departures endpoint takes a date string with spaces.
    const rest = url.pathname.replace(/^\/vt\//, '');
    if (!ENDPOINTS.has(rest.split('/')[0])) return new Response('Unknown endpoint', { status: 404, headers: cors });

    try {
      const upstream = await fetch(`${API}/${rest}${url.search}`, {
        headers: { 'User-Agent': 'traim/0.1 (app personale orari treni)' },
      });
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: {
          ...cors,
          'Content-Type': upstream.headers.get('content-type') ?? 'text/plain',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('ViaggiaTreno non raggiungibile', { status: 502, headers: cors });
    }
  },
};
