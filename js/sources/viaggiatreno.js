import { config } from '../config.js';
import { AppError } from '../errors.js';
import { MINUTE, titleCase } from '../util.js';

async function get(path, as = 'json') {
  let res;
  try {
    res = await fetch(`${config.vtBase}/${path}`);
  } catch {
    // fetch only rejects when the app's own server (the proxy) cannot be reached.
    throw new AppError('error.proxyDown');
  }
  if (res.status === 403) throw new AppError('error.vtBlocked');
  if (res.status === 502) throw new AppError('error.vtDown');
  if (!res.ok) throw new AppError('error.vtStatus', { status: res.status });
  const body = await res.text();
  if (as === 'text') return body;
  return body ? JSON.parse(body) : null;
}

export async function searchStations(text) {
  const q = text.trim().toUpperCase();
  if (q.length < 2) return [];
  const body = await get(`autocompletaStazione/${encodeURIComponent(q)}`, 'text');
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, code] = line.split('|');
      return { name: titleCase(name), vt: code.trim() };
    });
}

// The API wants the JS Date.toString() format, without the "(time zone name)" suffix.
const vtDate = (date) => date.toString().replace(/\s*\(.*\)$/, '');

function departures(stationCode, date) {
  return get(`partenze/${stationCode}/${encodeURIComponent(vtDate(date))}`).then((d) => d ?? []);
}

function trainStatus(originCode, number, departureDay) {
  return get(`andamentoTreno/${originCode}/${number}/${departureDay}`);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const station = (s) => (s && s !== '--' ? titleCase(s) : null);

function toTrip(s, fromCode, toCode, now) {
  const all = s?.fermate ?? [];
  const i = all.findIndex((f) => f.id === fromCode);
  const j = all.findIndex((f, k) => k > i && f.id === toCode);
  if (i < 0 || j < 0) return null;

  const a = all[i];
  const b = all[j];
  if (b.arrivoReale) return null;

  const delay = s.ritardo ?? null;
  const late = (delay ?? 0) * MINUTE;
  const depPlanned = a.partenza_teorica ?? a.programmata;
  const arrPlanned = b.arrivo_teorico ?? b.programmata;
  const departed = Boolean(a.partenzaReale);

  // Drop trains whose tracking stopped long ago: they would otherwise look "current" forever.
  if (!departed && depPlanned + late + 15 * MINUTE < now) return null;
  if (departed && arrPlanned + late + 30 * MINUTE < now) return null;

  const segment = all.slice(i, j + 1);
  const stops = segment.map((f, k) => {
    const arrP = k > 0 ? (f.arrivo_teorico ?? f.programmata) : null;
    const depP = k < segment.length - 1 ? (f.partenza_teorica ?? f.programmata) : null;
    return {
      name: titleCase(f.stazione),
      planned: k === 0 ? depP : arrP,
      arr: f.arrivoReale ?? (arrP && arrP + late),
      dep: f.partenzaReale ?? (depP && depP + late),
      passed: Boolean(f.partenzaReale),
      here: Boolean(f.arrivoReale && !f.partenzaReale),
    };
  });

  // The whole line, for the stop list: stops outside the trip are marked and only shown dimmed.
  const outside = (f, k) => {
    const arrP = k > 0 ? (f.arrivo_teorico ?? f.programmata) : null;
    const depP = k < all.length - 1 ? (f.partenza_teorica ?? f.programmata) : null;
    return {
      name: titleCase(f.stazione),
      planned: arrP ?? depP,
      arr: f.arrivoReale ?? (arrP && arrP + late),
      dep: f.partenzaReale ?? (depP && depP + late),
      passed: Boolean(f.partenzaReale),
      here: Boolean(f.arrivoReale && !f.partenzaReale),
      outside: true,
    };
  };
  const route = [
    ...all.slice(0, i).map(outside),
    ...stops,
    ...all.slice(j + 1).map((f, k) => outside(f, j + 1 + k)),
  ];

  const cancelled = s.provvedimento === 1 || a.actualFermataType === 3 || b.actualFermataType === 3;
  const platformReal = a.binarioEffettivoPartenzaDescrizione?.trim();
  const platformPlanned = a.binarioProgrammatoPartenzaDescrizione?.trim();

  return {
    key: `vt-${s.numeroTreno}-${s.dataPartenzaTreno}`,
    source: 'vt',
    trainNumber: String(s.numeroTreno),
    number: s.compNumeroTreno?.trim() || `${s.categoria ?? ''} ${s.numeroTreno}`.trim(),
    operator: 'Trenitalia',
    origin: station(s.origine),
    destination: station(s.destinazione),
    depPlanned,
    depExpected: a.partenzaReale ?? depPlanned + late,
    arrPlanned,
    arrExpected: arrPlanned + late,
    delay,
    realtime: true,
    status: cancelled ? 'cancelled' : departed ? 'travelling' : 'waiting',
    platform: platformReal || platformPlanned || null,
    platformChanged: Boolean(platformReal && platformPlanned && platformReal !== platformPlanned),
    stops,
    route,
    lastStation: station(s.stazioneUltimoRilevamento),
    lastSeen: s.oraUltimoRilevamento || null,
    notStarted: Boolean(s.nonPartito),
    note: s.subTitle?.trim() || null,
  };
}

// Trains from `from` that also stop at `to` later on and have not arrived there yet.
export async function findTrips(from, to, now, max) {
  const seen = new Set();
  const trips = [];

  // Start an hour back to catch trains already travelling between the two stations.
  // Each response covers a variable time span, so the next query starts after its last departure.
  let start = now - 60 * MINUTE;
  for (let page = 0; page < 5; page++) {
    const deps = await departures(from.vt, new Date(start));
    const lastDeparture = Math.max(0, ...deps.map((d) => d.orarioPartenza ?? 0));
    start = lastDeparture > start ? lastDeparture + MINUTE : start + 90 * MINUTE;
    const fresh = deps.filter((d) => {
      const key = `${d.numeroTreno}-${d.dataPartenzaTreno}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const statuses = await mapLimit(fresh, 6, (d) =>
      trainStatus(d.codOrigine, d.numeroTreno, d.dataPartenzaTreno).catch(() => null),
    );
    for (const s of statuses) {
      const trip = toTrip(s, from.vt, to.vt, now);
      if (trip) trips.push(trip);
    }
    if (trips.length >= max) break;
  }

  return trips;
}
