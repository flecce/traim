import { config } from './config.js';
import { AppError } from './errors.js';
import { sameStation } from './util.js';
import * as vt from './sources/viaggiatreno.js';
import * as sta from './sources/sta.js';

// A station is { name, vt, sta, mode }: its id in each source, or null when unknown / not covered,
// and whether it is a train station or a bus stop. Bus stops come from STA only.

export async function searchStations(text) {
  const [v, s] = await Promise.allSettled([vt.searchStations(text), sta.searchStations(text)]);
  if (v.status === 'rejected' && s.status === 'rejected') throw v.reason;

  const trains = (v.value ?? []).map((st) => ({ ...st, sta: null, mode: 'train' }));
  const buses = [];
  for (const st of s.value ?? []) {
    if (st.mode === 'bus') {
      buses.push({ name: st.name, vt: null, sta: st.sta, mode: 'bus' });
      continue;
    }
    const twin = trains.find((o) => o.vt && !o.sta && sameStation(o.name, st.name));
    if (twin) twin.sta = st.sta;
    else trains.push({ name: st.name, vt: null, sta: st.sta, mode: 'train' });
  }
  return [...trains.slice(0, 6), ...buses];
}

// Names already looked up without a match, so they are not searched again on every refresh.
const misses = new Set();

async function lookup(source, mod, name) {
  const key = `${source}:${name}`;
  if (misses.has(key)) return null;
  try {
    const found = (await mod.searchStations(name)).find((s) => s.mode !== 'bus' && sameStation(s.name, name));
    if (!found) misses.add(key);
    return found?.[source] ?? null;
  } catch {
    return null;
  }
}

// Fills in the id of the source the station was not picked from. Bus stops are only on STA.
export async function resolveStation(station) {
  if (station.mode === 'bus') return station;
  const [vtId, staId] = await Promise.all([
    station.vt ?? lookup('vt', vt, station.name),
    station.sta ?? lookup('sta', sta, station.name),
  ]);
  return { ...station, vt: vtId, sta: staId };
}

// The rest of the line fetched for STA trips, by trip key: ViaggiaTreno trips carry theirs already.
const routes = new Map();

// The trip's stops with the rest of the line around them, if already known.
// Cached parts are joined to the trip's current stops, so their progress stays fresh.
export function knownRoute(trip) {
  if (trip.route) return trip.route;
  const around = routes.get(trip.key);
  return around ? [...around.before, ...trip.stops, ...around.after] : null;
}

// Asked only when the stop list is opened: it costs STA one more request per train.
export async function loadRoute(trip) {
  if (knownRoute(trip) || trip.source !== 'sta') return knownRoute(trip);
  try {
    const around = await sta.fullRoute(trip);
    if (around) routes.set(trip.key, around);
    return knownRoute(trip);
  } catch {
    return null;
  }
}

// ViaggiaTreno wins for trains present in both: it reports where the train was actually detected.
// Trains already on their way are always kept, on top of `max` upcoming departures.
function merge(results, max) {
  const vtTrips = results.vt ?? [];
  const vtNumbers = new Set(vtTrips.map((t) => t.trainNumber));
  const all = [...vtTrips, ...(results.sta ?? []).filter((t) => !vtNumbers.has(t.trainNumber))].sort(
    (a, b) => a.depPlanned - b.depPlanned,
  );
  const travelling = all.filter((t) => t.status === 'travelling');
  const upcoming = all.filter((t) => t.status !== 'travelling').slice(0, max);
  return [...travelling, ...upcoming];
}

// Calls onUpdate(trips, errors) every time a source answers, so the fast one shows up first.
// With a window ({ start, end } in ms) it lists every departure in it instead of the next few.
export async function findTrains(from, to, { max = config.maxTrains, onUpdate, window = null } = {}) {
  const now = Date.now();
  const mode = from.mode === 'bus' ? 'bus' : 'train';
  const results = {};
  const errors = {};
  const sources = [];
  if (window) max = 20;

  const pick = (all) => {
    if (!window) return merge(all, max);
    return merge(all, max).filter((t) => t.depPlanned >= window.start && t.depPlanned <= window.end);
  };

  const run = async (name, mod) => {
    sources.push(name);
    try {
      // Ask for a few more: trains already on their way also count towards a source's limit.
      results[name] = await mod.findTrips(from, to, now, max + 2, {
        mode,
        ...(window && { start: window.start }),
      });
    } catch (err) {
      errors[name] = err;
    }
    onUpdate?.(pick(results), { ...errors });
  };

  // ViaggiaTreno only knows trains running now: it is skipped for a window that starts later on.
  const live = !window || window.start < now + 60 * 60_000;
  const jobs = [];
  if (from.sta && to.sta) jobs.push(run('sta', sta));
  if (mode === 'train' && live && from.vt && to.vt) jobs.push(run('vt', vt));
  if (!jobs.length) throw new AppError('error.noSource');
  await Promise.all(jobs);

  if (Object.keys(errors).length === jobs.length) throw errors.vt ?? errors.sta;
  return { trips: pick(results), errors, sources };
}
