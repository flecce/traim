import { config } from './config.js';
import { AppError } from './errors.js';
import { sameStation } from './util.js';
import * as vt from './sources/viaggiatreno.js';
import * as sta from './sources/sta.js';

// A station is { name, vt, sta }: its id in each source, or null when unknown / not covered.

export async function searchStations(text) {
  const [v, s] = await Promise.allSettled([vt.searchStations(text), sta.searchStations(text)]);
  if (v.status === 'rejected' && s.status === 'rejected') throw v.reason;

  const out = (v.value ?? []).map((st) => ({ ...st, sta: null }));
  for (const st of s.value ?? []) {
    const twin = out.find((o) => o.vt && !o.sta && sameStation(o.name, st.name));
    if (twin) twin.sta = st.sta;
    else out.push({ name: st.name, vt: null, sta: st.sta });
  }
  return out;
}

// Names already looked up without a match, so they are not searched again on every refresh.
const misses = new Set();

async function lookup(source, mod, name) {
  const key = `${source}:${name}`;
  if (misses.has(key)) return null;
  try {
    const found = (await mod.searchStations(name)).find((s) => sameStation(s.name, name));
    if (!found) misses.add(key);
    return found?.[source] ?? null;
  } catch {
    return null;
  }
}

// Fills in the id of the source the station was not picked from.
export async function resolveStation(station) {
  const [vtId, staId] = await Promise.all([
    station.vt ?? lookup('vt', vt, station.name),
    station.sta ?? lookup('sta', sta, station.name),
  ]);
  return { ...station, vt: vtId, sta: staId };
}

// ViaggiaTreno wins for trains present in both: it reports where the train was actually detected.
function merge(results, max) {
  const vtTrips = results.vt ?? [];
  const vtNumbers = new Set(vtTrips.map((t) => t.trainNumber));
  return [...vtTrips, ...(results.sta ?? []).filter((t) => !vtNumbers.has(t.trainNumber))]
    .sort((a, b) => a.depPlanned - b.depPlanned)
    .slice(0, max);
}

// Calls onUpdate(trips, errors) every time a source answers, so the fast one shows up first.
export async function findTrains(from, to, { max = config.maxTrains, onUpdate } = {}) {
  const now = Date.now();
  const results = {};
  const errors = {};
  const sources = [];

  const run = async (name, mod) => {
    sources.push(name);
    try {
      results[name] = await mod.findTrips(from, to, now, max);
    } catch (err) {
      errors[name] = err;
    }
    onUpdate?.(merge(results, max), { ...errors });
  };

  const jobs = [];
  if (from.sta && to.sta) jobs.push(run('sta', sta));
  if (from.vt && to.vt) jobs.push(run('vt', vt));
  if (!jobs.length) throw new AppError('error.noSource');
  await Promise.all(jobs);

  if (Object.keys(errors).length === jobs.length) throw errors.vt ?? errors.sta;
  return { trips: merge(results, max), errors, sources };
}
