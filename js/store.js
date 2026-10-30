import * as google from './google.js';

const ROUTES_KEY = 'traim.routes';
// Ids known to be in the Drive sheet: if one disappears there, it was deleted on another device.
const SYNCED_KEY = 'traim.syncedIds';
const HEADER = ['id', 'name', 'from_name', 'from_vt', 'from_sta', 'to_name', 'to_vt', 'to_sta', 'mode'];

export function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage disabled: data still lives in memory and in Drive.
  }
}

// Routes saved before multi-source support kept the ViaggiaTreno id in `code`; before buses, all were trains.
const station = (s) => ({ name: s.name, vt: s.vt ?? s.code ?? null, sta: s.sta ?? null, mode: s.mode ?? 'train' });
const normalize = (r) => ({ id: r.id, name: r.name, from: station(r.from), to: station(r.to) });

let routes = readLocal(ROUTES_KEY, []).map(normalize);

export const getRoutes = () => routes;
export const getRoute = (id) => routes.find((r) => r.id === id);

const newId = () => globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36);

const toRow = (r) => [r.id, r.name, r.from.name, r.from.vt ?? '', r.from.sta ?? '', r.to.name, r.to.vt ?? '', r.to.sta ?? '', r.from.mode];

const fromRow = ([id, name, fromName, fromVt, fromSta, toName, toVt, toSta, mode]) => ({
  id,
  name: name || `${fromName} → ${toName}`,
  from: { name: fromName, vt: fromVt || null, sta: fromSta || null, mode: mode || 'train' },
  to: { name: toName, vt: toVt || null, sta: toSta || null, mode: mode || 'train' },
});

// Saves locally and, when signed in, to Drive. Throws only if the Drive write fails.
async function persist() {
  writeLocal(ROUTES_KEY, routes);
  if (!google.isSignedIn()) return;
  await google.writeRows(google.TABS.routes, HEADER, routes.map(toRow));
  writeLocal(SYNCED_KEY, routes.map((r) => r.id));
}

export async function addRoute(route) {
  routes = [...routes, normalize({ id: newId(), ...route })];
  await persist();
}

export async function updateRoute(id, patch) {
  routes = routes.map((r) => (r.id === id ? { ...r, ...patch } : r));
  await persist();
}

// ids lists every route in the wanted order.
export async function reorderRoutes(ids) {
  const byId = new Map(routes.map((r) => [r.id, r]));
  routes = ids.map((id) => byId.get(id)).filter(Boolean);
  await persist();
}

export async function removeRoute(id) {
  routes = routes.filter((r) => r.id !== id);
  await persist();
}

export async function syncFromDrive() {
  const remote = (await google.readRows(google.TABS.routes)).filter((r) => r[0] && r[2] && r[5]).map(fromRow);
  const remoteIds = new Set(remote.map((r) => r.id));
  const synced = new Set(readLocal(SYNCED_KEY, []));
  const localOnly = routes.filter((r) => !remoteIds.has(r.id) && !synced.has(r.id));
  routes = [...remote, ...localOnly];
  writeLocal(ROUTES_KEY, routes);
  if (localOnly.length) await google.writeRows(google.TABS.routes, HEADER, routes.map(toRow));
  writeLocal(SYNCED_KEY, routes.map((r) => r.id));
}
