import { config } from '../config.js';
import { AppError } from '../errors.js';
import { MINUTE } from '../util.js';

// EFA product classes: 0 train, 1 suburban rail, 5-7 city, regional and express buses;
// the others are trams, cable cars and the like.
// Classes 12-19 must stay allowed: excluding them makes EFA find no trips at all.
const TRAIN_CLASSES = [0, 1];
const BUS_CLASSES = [5, 6, 7];
const EXCLUDED = {
  train: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 17],
  bus: [0, 1, 2, 3, 4, 8, 9, 10, 11],
};

async function get(endpoint, params) {
  params.set('outputFormat', 'rapidJSON');
  // Italian names keep stations comparable with ViaggiaTreno's.
  params.set('language', 'it');
  let res;
  try {
    res = await fetch(`${config.staBase}/${endpoint}?${params}`);
  } catch {
    throw new AppError('error.staDown');
  }
  if (!res.ok) throw new AppError('error.staStatus', { status: res.status });
  return res.json();
}

// "Postal, Stazione di Lana - Postal" -> "Lana - Postal"
const cleanName = (name = '') => name.replace(/^.*?,\s*Stazione di\s+/i, '');

const time = (iso) => (iso ? Date.parse(iso) : null);

// EFA expects local Italian time, whatever the device time zone is.
function romeDateTime(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}${p.month}${p.day}`, time: `${p.hour}${p.minute}` };
}

export async function searchStations(text) {
  const q = text.trim();
  if (q.length < 2) return [];
  const data = await get('XML_STOPFINDER_REQUEST', new URLSearchParams({ type_sf: 'any', anyObjFilter_sf: '2', name_sf: q }));
  // A station served by both trains and buses is listed once for each.
  return (data.locations ?? []).flatMap((l) => {
    const classes = l.productClasses ?? [];
    const stop = { name: cleanName(l.name), sta: l.id };
    return [
      ...(classes.some((c) => TRAIN_CLASSES.includes(c)) ? [{ ...stop, mode: 'train' }] : []),
      ...(classes.some((c) => BUS_CLASSES.includes(c)) ? [{ ...stop, mode: 'bus' }] : []),
    ];
  });
}

// Stops the train passes without stopping come with no times.
const timedStops = (leg) => (leg.stopSequence ?? []).filter((s) => s.departureTimePlanned || s.arrivalTimePlanned);

function toStop(s, k, last, now) {
  const arrP = time(s.arrivalTimePlanned);
  const depP = time(s.departureTimePlanned);
  const arr = time(s.arrivalTimeEstimated) ?? arrP;
  const dep = time(s.departureTimeEstimated) ?? depP;
  return {
    name: cleanName(s.name),
    planned: k === 0 ? depP : (arrP ?? depP),
    expected: k === 0 ? dep : (arr ?? dep),
    arr,
    dep,
    passed: k < last ? dep != null && dep <= now : arr != null && arr <= now,
    here: k > 0 && k < last && arr != null && dep != null && arr <= now && now < dep,
  };
}

const isBus = (leg) => BUS_CLASSES.includes(leg.transportation?.product?.class);

function rideName(leg) {
  const tr = leg.transportation ?? {};
  if (isBus(leg)) return `Bus ${tr.disassembledName ?? tr.number ?? ''}`.trim();
  const trainNumber = String(tr.properties?.trainNumber ?? tr.number ?? '');
  return `${tr.disassembledName ?? tr.properties?.trainType ?? ''} ${trainNumber}`.trim();
}

// One trip from its rides: a single train or bus, or two buses with a change between them.
function toTrip(rides, now) {
  const legs = rides.map((leg) => {
    const seq = timedStops(leg);
    return seq.map((s, k) => toStop(s, k, seq.length - 1, now));
  });
  if (legs.some((stops) => stops.length < 2)) return null;
  const stops = legs.flat();

  const a = stops[0];
  const b = stops[stops.length - 1];
  if (b.passed) return null;

  const leg = rides[0];
  const tr = leg.transportation ?? {};
  const statuses = rides.flatMap((r) => r.realtimeStatus ?? []);
  const realtime = statuses.includes('MONITORED');
  const cancelled = statuses.some((s) => s.includes('CANCEL'));
  const upcoming = stops.find((s) => !s.passed) ?? b;
  const delay = realtime ? Math.round((upcoming.expected - upcoming.planned) / MINUTE) : null;
  const props = tr.properties ?? {};
  const trainNumber = rides.map((r) => String(r.transportation?.properties?.trainNumber ?? r.transportation?.number ?? '')).join('+');
  const bus = rides.some(isBus);
  const platform = !bus && leg.origin?.type === 'platform' ? leg.origin.disassembledName : null;
  const lastTr = rides[rides.length - 1].transportation ?? {};

  return {
    key: `sta-${rides.map((r) => r.transportation?.properties?.RealtimeTripId ?? rideName(r)).join('+')}-${a.planned}`,
    source: 'sta',
    mode: bus ? 'bus' : 'train',
    trainNumber,
    number: rides.map(rideName).join(' → '),
    operator: [...new Set(rides.map((r) => r.transportation?.operator?.name).filter(Boolean))].join(', ') || null,
    origin: null,
    destination: cleanName(lastTr.destination?.name),
    // Where to change, for trips made of two rides.
    change: rides.length > 1 ? legs[1][0].name : null,
    depPlanned: a.planned,
    depExpected: a.expected,
    arrPlanned: b.planned,
    arrExpected: b.expected,
    delay,
    realtime,
    status: cancelled ? 'cancelled' : a.passed ? 'travelling' : 'waiting',
    platform: platform && platform.length <= 4 ? platform : null,
    platformChanged: false,
    stops: stops.map(({ expected, ...s }) => s),
    // What fullRoute() needs to ask for the stops outside this trip.
    routeQuery: rides.length === 1 && tr.id && props.tripCode != null && {
      line: tr.id,
      stop: leg.origin?.parent?.id ?? leg.origin?.id,
      tripCode: String(props.tripCode),
      ...romeDateTime(a.planned),
    },
    lastStation: null,
    lastSeen: null,
    notStarted: false,
    note: null,
  };
}

// The rest of the line before and after the trip, its stops marked `outside`.
export async function fullRoute(trip) {
  const q = trip.routeQuery;
  if (!q) return null;
  const data = await get(
    'XML_STOPSEQCOORD_REQUEST',
    new URLSearchParams({ line: q.line, stop: q.stop, tripCode: q.tripCode, date: q.date, time: q.time, tStOTType: 'all', useRealtime: '1' }),
  );
  const seq = timedStops(data.leg ?? {});
  const now = Date.now();
  const all = seq.map((s, k) => toStop(s, k, seq.length - 1, now));
  const first = trip.stops[0];
  const last = trip.stops[trip.stops.length - 1];
  const i = all.findIndex((s) => s.name === first.name);
  const j = all.findIndex((s, k) => k > i && s.name === last.name);
  if (i < 0 || j < 0) return null;
  const outside = ({ expected, ...s }) => ({ ...s, outside: true });
  return { before: all.slice(0, i).map(outside), after: all.slice(j + 1).map(outside) };
}

// mode is 'train' or 'bus'. Buses may need one change, trains are direct only.
// start defaults to an hour back, to catch trips already travelling between the two stops.
export async function findTrips(from, to, now, max, { mode = 'train', start = now - 60 * MINUTE } = {}) {
  const at = romeDateTime(start);
  const params = new URLSearchParams({
    type_origin: 'any',
    name_origin: from.sta,
    type_destination: 'any',
    name_destination: to.sta,
    itdDate: at.date,
    itdTime: at.time,
    itdTripDateTimeDepArr: 'dep',
    calcNumberOfTrips: String(max + 6),
    maxChanges: mode === 'bus' ? '1' : '0',
    useRealtime: '1',
    excludedMeans: 'checkbox',
  });
  for (const c of EXCLUDED[mode]) params.set(`exclMOT_${c}`, '1');

  const data = await get('XML_TRIP_REQUEST2', params);
  const allowed = mode === 'bus' ? BUS_CLASSES : TRAIN_CLASSES;
  const trips = [];
  const seen = new Set();
  for (const journey of data.journeys ?? []) {
    // Footpaths between rides have no product class among these.
    const rides = journey.legs.filter((l) => allowed.includes(l.transportation?.product?.class));
    if (!rides.length || rides.length > (mode === 'bus' ? 2 : 1)) continue;
    const trip = toTrip(rides, now);
    if (trip && !seen.has(trip.key)) {
      seen.add(trip.key);
      trips.push(trip);
    }
  }
  if (mode !== 'bus') return trips;
  // Drop bus detours: a trip is pointless when another leaves no earlier and arrives no later.
  return trips.filter(
    (x) =>
      !trips.some(
        (y) =>
          y !== x &&
          y.depPlanned >= x.depPlanned &&
          y.arrPlanned <= x.arrPlanned &&
          (y.depPlanned > x.depPlanned || y.arrPlanned < x.arrPlanned),
      ),
  );
}
