import { config } from '../config.js';
import { AppError } from '../errors.js';
import { MINUTE } from '../util.js';

// EFA product classes: 0 train, 1 suburban rail; these are buses, trams, cable cars and the like.
// Classes 12-19 must stay allowed: excluding them makes EFA find no trips at all.
const NON_TRAIN_CLASSES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 17];

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
  return (data.locations ?? [])
    .filter((l) => l.productClasses?.includes(0))
    .map((l) => ({ name: cleanName(l.name), sta: l.id }));
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

function toTrip(leg, now) {
  const tr = leg.transportation ?? {};
  const seq = timedStops(leg);
  if (seq.length < 2) return null;

  const last = seq.length - 1;
  const stops = seq.map((s, k) => toStop(s, k, last, now));

  const a = stops[0];
  const b = stops[last];
  if (b.passed) return null;

  const status = leg.realtimeStatus ?? [];
  const realtime = status.includes('MONITORED');
  const cancelled = status.some((s) => s.includes('CANCEL'));
  const upcoming = stops.find((s) => !s.passed) ?? b;
  const delay = realtime ? Math.round((upcoming.expected - upcoming.planned) / MINUTE) : null;
  const props = tr.properties ?? {};
  const trainNumber = String(props.trainNumber ?? tr.number ?? '');
  const platform = leg.origin?.type === 'platform' ? leg.origin.disassembledName : null;

  return {
    key: `sta-${props.RealtimeTripId ?? trainNumber}-${a.planned}`,
    source: 'sta',
    trainNumber,
    number: `${tr.disassembledName ?? props.trainType ?? ''} ${trainNumber}`.trim(),
    operator: tr.operator?.name ?? null,
    origin: null,
    destination: cleanName(tr.destination?.name),
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
    routeQuery: tr.id && props.tripCode != null && {
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

export async function findTrips(from, to, now, max) {
  // Start an hour back to catch trains already travelling between the two stations.
  const start = romeDateTime(now - 60 * MINUTE);
  const params = new URLSearchParams({
    type_origin: 'any',
    name_origin: from.sta,
    type_destination: 'any',
    name_destination: to.sta,
    itdDate: start.date,
    itdTime: start.time,
    itdTripDateTimeDepArr: 'dep',
    calcNumberOfTrips: String(max + 6),
    maxChanges: '0',
    useRealtime: '1',
    excludedMeans: 'checkbox',
  });
  for (const c of NON_TRAIN_CLASSES) params.set(`exclMOT_${c}`, '1');

  const data = await get('XML_TRIP_REQUEST2', params);
  const trips = [];
  for (const journey of data.journeys ?? []) {
    const rides = journey.legs.filter((l) => [0, 1].includes(l.transportation?.product?.class));
    if (rides.length !== 1) continue;
    const trip = toTrip(rides[0], now);
    if (trip) trips.push(trip);
  }
  return trips;
}
