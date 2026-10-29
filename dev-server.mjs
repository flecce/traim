// Static server for the app plus a same-origin proxy to ViaggiaTreno (which sends no CORS headers).
// Usage: node dev-server.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = import.meta.dirname;
const port = Number(process.argv[2]) || 8080;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const API = 'https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
// Only the endpoints the app uses, so this is not an open proxy.
const ENDPOINTS = new Set(['autocompletaStazione', 'partenze', 'andamentoTreno']);

async function proxy(res, rest, search) {
  if (!ENDPOINTS.has(rest.split('/')[0])) return res.writeHead(404).end('Unknown endpoint');
  try {
    const upstream = await fetch(`${API}/${rest}${search}`, {
      headers: { 'User-Agent': 'traim/0.1 (app personale orari treni)' },
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok) console.warn(`ViaggiaTreno ${upstream.status} su ${rest}`);
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'text/plain',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    console.error(`Proxy ViaggiaTreno: ${err.message}`);
    res.writeHead(502).end('ViaggiaTreno non raggiungibile');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Forward the still-encoded path: the departures endpoint takes a date string with spaces.
  if (url.pathname.startsWith('/vt/')) return proxy(res, url.pathname.slice(4), url.search);

  const path = decodeURIComponent(url.pathname);
  const file = normalize(join(root, path.endsWith('/') ? `${path}index.html` : path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`Traim su http://localhost:${port}`));
