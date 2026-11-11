import { config } from './config.js';
import { LANGUAGES, locale, t } from './i18n.js';
import { icons } from './icons.js';
import { findTrains, knownRoute, loadRoute, planJourneys, resolveStation, searchStations, searchStops } from './trains.js';
import * as google from './google.js';
import * as store from './store.js';
import * as plans from './plans.js';
import { readLocal, writeLocal } from './store.js';
import * as settings from './settings.js';
import * as pwa from './pwa.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');

const SOURCE_NAMES = { vt: 'ViaggiaTreno', sta: 'STA' };

let refreshTimer = null;
// Bumped on every navigation so late responses from a previous page are ignored.
let renderTicket = 0;

/* ---------- Helpers ---------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const strong = (s) => `<strong>${esc(s)}</strong>`;

const hhmm = (ms) => (ms ? new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '--:--');

const errText = (err) => (err?.code ? t(err.code, err.vars) : (err?.message ?? String(err)));

const path = (from, to) => `${from.name} → ${to.name}`;

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
}

// Delete buttons ask to be tapped twice: the first tap shows `label` for a few seconds, the second confirms.
// Not confirm(): installed apps and embedded browsers may block it, and it then answers "no" at once.
function confirmTap(button, label) {
  if (button.classList.contains('armed')) return true;
  const original = button.innerHTML;
  button.classList.add('armed');
  button.innerHTML = label;
  setTimeout(() => {
    if (!button.isConnected) return;
    button.classList.remove('armed');
    button.innerHTML = original;
  }, 4000);
  return false;
}

async function run(action) {
  try {
    await action();
  } catch (err) {
    toast(errText(err));
  }
}

// Local saves always succeed; a failed Drive write is only reported.
async function save(action) {
  try {
    await action();
  } catch (err) {
    toast(t('error.driveSave', { message: errText(err) }));
  }
}

function duration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function countdown(trip) {
  if (trip.status === 'cancelled') return '';
  const travelling = trip.status === 'travelling';
  const minutes = Math.round(((travelling ? trip.arrExpected : trip.depExpected) - Date.now()) / 60_000);
  if (travelling) return minutes <= 0 ? t('count.arriving') : t('count.arrivesIn', { d: duration(minutes) });
  return minutes <= 0 ? t('count.departing') : t('count.departsIn', { d: duration(minutes) });
}

// compact: "-2 min" instead of "2 min early", for narrow rows.
function delayBadge(trip, compact = false) {
  if (trip.status === 'cancelled') return `<span class="badge bad">${t('badge.cancelled')}</span>`;
  if (trip.delay == null || (trip.notStarted && !trip.lastStation)) {
    return `<span class="badge muted">${t('badge.scheduled')}</span>`;
  }
  if (trip.delay < 0) {
    return `<span class="badge ok">${compact ? `${trip.delay} min` : t('badge.early', { n: -trip.delay })}</span>`;
  }
  if (trip.delay === 0) return `<span class="badge ok">${t('badge.onTime')}</span>`;
  return `<span class="badge ${trip.delay >= 10 ? 'bad' : 'warn'}">+${trip.delay} min</span>`;
}

// Minutes between the timetable and the real-time estimate: 0 when on time or unknown.
// Compared minute by minute, as the clock shows them, so the two times never read the same.
const shift = (planned, expected) =>
  planned && expected ? Math.floor(expected / 60_000) - Math.floor(planned / 60_000) : 0;

// "At the station" for trains, "at the stop" for buses.
const atStop = (trip) => (trip.mode === 'bus' ? 'time.atStop' : 'time.atStation');

// Big times follow the timetable; this line adds the real one when the train is late or early.
function actualLine(trip, key, vars, minutes) {
  if (!minutes || trip.status === 'cancelled') return '';
  return `<span class="actual ${minutes > 0 ? 'late' : 'early'}">${t(key, vars)}</span>`;
}

function time(planned, expected) {
  if (!expected || expected - planned < 60_000) return hhmm(planned);
  return `<s>${hhmm(planned)}</s>${hhmm(expected)}`;
}

const sourceChip = (trip) => `<span class="source source-${trip.source}">${SOURCE_NAMES[trip.source]}</span>`;

function platformText(trip) {
  if (!trip.platform) return '';
  const changed = trip.platformChanged ? ` (${t('train.platformChanged')})` : '';
  return t('train.platform', { platform: esc(trip.platform) }) + changed;
}

// Fills in missing source ids and remembers them on the route.
async function resolvedRoute(route) {
  const [from, to] = await Promise.all([resolveStation(route.from), resolveStation(route.to)]);
  const changed = ['vt', 'sta'].some((k) => from[k] !== route.from[k] || to[k] !== route.to[k]);
  if (changed) await save(() => store.updateRoute(route.id, { from, to }));
  return { from, to };
}

function pageHead(title, subtitle = '', actions = '') {
  return `
    <header class="page-head">
      <a href="#/" class="icon-btn" aria-label="${t('route.back')}">${icons.back}</a>
      <div class="page-title">
        <h1>${esc(title)}</h1>
        ${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}
      </div>
      ${actions}
    </header>`;
}

/* ---------- Card colours ---------- */

// Keys saved on the route; the colours themselves are in the CSS (.tint-<key>).
const COLORS = ['green', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'gray'];
const tintClass = (color) => (COLORS.includes(color) ? `has-color tint-${color}` : '');

function colorPicker(value) {
  const swatch = (key) => {
    const label = t(`color.${key || 'none'}`);
    return `
      <label class="swatch ${key ? `tint-${key}` : 'swatch-none'}" title="${label}">
        <input type="radio" name="color" value="${key}" ${(value ?? '') === key ? 'checked' : ''} aria-label="${label}">
        <span></span>
      </label>`;
  };
  return `
    <div class="field">
      <span class="field-label">${t('color.label')}</span>
      <div class="swatches" role="radiogroup" aria-label="${t('color.label')}">${['', ...COLORS].map(swatch).join('')}</div>
    </div>`;
}

const pickedColor = (root) => root.querySelector('input[name=color]:checked')?.value || null;

/* ---------- Date and time: "now" (live) unless another moment is picked ---------- */

// Start of the departures shown on the home and in the planner, or null for live.
// Kept while moving between pages, back to live on every app start.
let when = null;
const HOURS_AFTER = 6 * 60 * 60_000;

const pad = (n) => String(n).padStart(2, '0');
const dayValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function longDate(ms) {
  const date = new Date(ms).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  return `${date.charAt(0).toUpperCase()}${date.slice(1)}`;
}

// The "now / pick" chips and the day and time fields. `extra` goes at the end of the chip row.
function whenBar(extra = '') {
  const at = new Date(when ?? Date.now());
  return `
    <div class="chips">
      <button type="button" class="chip ${when ? '' : 'on'}" data-when="now" aria-pressed="${!when}">
        <span class="live-dot" aria-hidden="true"></span>${t('when.now')}
      </button>
      <button type="button" class="chip ${when ? 'on' : ''}" data-when="pick" aria-pressed="${Boolean(when)}">${icons.calendar}${t('when.pick')}</button>
      ${extra}
    </div>
    <form class="when-form card" id="when-form" ${when ? '' : 'hidden'}>
      <label>${t('when.day')}<input type="date" id="when-day" required value="${dayValue(at)}"></label>
      <label>${t('when.time')}<input type="time" id="when-time" required value="${timeValue(at)}"></label>
    </form>`;
}

// onChange runs after the moment changed; the page then reloads its data.
function bindWhen(onChange) {
  const form = view.querySelector('#when-form');
  const day = view.querySelector('#when-day');
  const hour = view.querySelector('#when-time');
  const apply = () => {
    if (!day.value || !hour.value) return;
    when = new Date(`${day.value}T${hour.value}`).getTime();
    onChange();
  };
  [day, hour].forEach((input) => input.addEventListener('change', apply));
  form.addEventListener('submit', (e) => e.preventDefault());
  view.querySelectorAll('[data-when]').forEach((chip) =>
    chip.addEventListener('click', () => {
      if (chip.dataset.when === 'now') {
        when = null;
        return onChange();
      }
      if (!when) apply();
    }),
  );
}

// Countdowns only help when the picked moment is close; not for a train tomorrow.
const showCountdown = (depExpected) => !when || depExpected - Date.now() < 3 * 60 * 60_000;

/* ---------- Home: greeting and saved routes with their next trains ---------- */

function greeting() {
  const hour = new Date().getHours();
  return t(hour < 12 ? 'home.morning' : hour < 18 ? 'home.afternoon' : 'home.evening');
}

// Today and the time, or the picked day with "from 08:00".
function today() {
  if (when) return `${longDate(when)} · ${t('when.since', { time: hhmm(when) })}`;
  return `${longDate(Date.now())} · ${hhmm(Date.now())}`;
}

// While on, the home lists routes for sorting instead of opening them, so a scroll never moves a card.
let reordering = false;

function renderHome() {
  const routes = store.getRoutes();
  if (reordering && routes.length > 1) return renderReorder(routes);
  reordering = false;
  view.innerHTML = `
    <header class="hello">
      <div>
        <p class="hello-date">${today()}</p>
        <h1>${greeting()}</h1>
      </div>
      ${
        routes.length > 1
          ? `<button class="icon-btn" id="reorder" aria-label="${t('home.reorder')}" title="${t('home.reorder')}">${icons.reorder}</button>`
          : ''
      }
    </header>
    ${routes.length ? whenBar(filterChips(routes)) : ''}
    ${
      routes.length
        ? `<ul class="routes">${shownRoutes(routes).map(routeCard).join('')}</ul>`
        : `<div class="empty-state">
             <img src="icons/icon-192.png" alt="" width="72" height="72">
             <p>${t('home.empty')}</p>
             <a class="btn primary" href="#/new">${icons.plus}${t('home.addFirst')}</a>
           </div>`
    }`;

  view.querySelector('#reorder')?.addEventListener('click', () => {
    reordering = true;
    render();
  });
  view.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      writeLocal(FILTER_KEY, b.dataset.filter);
      render();
    }),
  );
  if (routes.length) bindWhen(render);

  const ticket = renderTicket;
  const departures = new Map();
  shownRoutes(routes).forEach((r) => loadNext(r, ticket, departures));
}

/* Train / bus filter, remembered on this device. Shown only when both kinds of route exist. */
const FILTER_KEY = 'traim.homeFilter';
const routeMode = (r) => (r.from.mode === 'bus' ? 'bus' : 'train');
const homeFilter = (routes) => {
  const kinds = new Set(routes.map(routeMode));
  const f = readLocal(FILTER_KEY, 'all');
  return kinds.size > 1 && kinds.has(f) ? f : 'all';
};
const shownRoutes = (routes) => {
  const f = homeFilter(routes);
  return f === 'all' ? routes : routes.filter((r) => routeMode(r) === f);
};

function filterChips(routes) {
  if (new Set(routes.map(routeMode)).size < 2) return '';
  const f = homeFilter(routes);
  const chip = (value, label, icon = '') =>
    `<button type="button" class="chip ${f === value ? 'on' : ''}" data-filter="${value}" aria-pressed="${f === value}">${icon}${label}</button>`;
  // Goes in the same row as the date chips, after a divider.
  return `<span class="chips-sep" aria-hidden="true"></span>${chip('all', t('filter.all'))}${chip('train', t('filter.train'), icons.train)}${chip('bus', t('filter.bus'), icons.bus)}`;
}

function renderReorder(routes) {
  view.innerHTML = `
    <header class="hello">
      <div>
        <h1>${t('home.reorder')}</h1>
        <p class="hello-date">${t('home.reorderHint')}</p>
      </div>
      <button class="btn primary" id="reorder-done">${t('home.reorderDone')}</button>
    </header>
    <ul class="routes sorting">
      ${routes
        .map((r) => {
          const p = path(r.from, r.to);
          return `
            <li class="sort-item" data-id="${esc(r.id)}">
              <span class="sort-grip" aria-hidden="true">${icons.grip}</span>
              <span class="sort-text">
                <span class="rc-name">${esc(r.name)}</span>
                ${r.name !== p ? `<span class="rc-path">${esc(p)}</span>` : ''}
              </span>
              <button class="icon-btn sort-up" data-move="-1" aria-label="${t('home.moveUp')}">${icons.chevron}</button>
              <button class="icon-btn" data-move="1" aria-label="${t('home.moveDown')}">${icons.chevron}</button>
            </li>`;
        })
        .join('')}
    </ul>`;

  const list = view.querySelector('.sorting');
  const saveOrder = () => save(() => store.reorderRoutes([...list.children].map((li) => li.dataset.id)));

  view.querySelector('#reorder-done').addEventListener('click', () => {
    reordering = false;
    render();
  });

  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-move]');
    if (!button) return;
    const li = button.closest('li');
    if (button.dataset.move === '-1') li.previousElementSibling?.before(li);
    else li.nextElementSibling?.after(li);
    button.focus();
    saveOrder();
  });

  // Dragging a card: it swaps place with the card under the finger once past that card's middle.
  let dragged = null;
  list.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    dragged = event.target.closest('li');
    if (!dragged) return;
    event.preventDefault();
    dragged.setPointerCapture(event.pointerId);
    dragged.classList.add('dragging');
  });
  list.addEventListener('pointermove', (event) => {
    if (!dragged) return;
    const over = [...list.children].find((li) => {
      const box = li.getBoundingClientRect();
      return li !== dragged && event.clientY >= box.top && event.clientY <= box.bottom;
    });
    if (!over) return;
    const box = over.getBoundingClientRect();
    if (event.clientY < box.top + box.height / 2) over.before(dragged);
    else over.after(dragged);
  });
  const drop = () => {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged = null;
    saveOrder();
  };
  list.addEventListener('pointerup', drop);
  list.addEventListener('pointercancel', drop);
}

function routeCard(r) {
  const p = path(r.from, r.to);
  const id = esc(r.id);
  return `
    <li>
      <a class="route-card ${tintClass(r.color)}" href="#/route/${id}" id="card-${id}">
        <span class="rc-name">${modeIcon(routeMode(r))}${esc(r.name)} <span class="rc-arr" id="arr-${id}"></span></span>
        ${r.name !== p ? `<span class="rc-path">${esc(p)}</span>` : ''}
        <span class="rc-live" id="live-${id}"></span>
        <span class="rc-row">
          <span class="rc-main" id="next-${id}"><span class="skeleton"></span></span>
          <span class="pill rc-count" id="count-${id}" hidden></span>
        </span>
        <span class="rc-actual" id="actual-${id}"></span>
        <span class="rc-then" id="then-${id}"></span>
      </a>
    </li>`;
}

// The card whose next train leaves first gets highlighted.
function highlightSoonest(departures) {
  let soonest = null;
  for (const [id, at] of departures) if (soonest == null || at < departures.get(soonest)) soonest = id;
  view.querySelectorAll('.route-card').forEach((card) => card.classList.toggle('is-soonest', card.id === `card-${soonest}`));
}

async function loadNext(route, ticket, departures) {
  const el = (prefix) => (ticket === renderTicket ? document.getElementById(`${prefix}-${route.id}`) : null);
  // The card shows trains already on their way above the next departure.
  const show = (trips) => {
    const main = el('next');
    if (!main) return;
    const upcoming = trips.filter((x) => x.status !== 'travelling');
    const travelling = trips.filter((x) => x.status === 'travelling');
    const next = upcoming[0] ?? trips[0];
    const struck = (x, text) => (x.status === 'cancelled' ? `<s>${text}</s>` : text);
    const count = el('count');
    const then = el('then');
    el('live').innerHTML = travelling
      .map(
        (x) => `
        <span class="live-train">
          <span class="live-dot" aria-hidden="true"></span>
          <span>${t('home.onTheWay', { train: esc(x.number), time: hhmm(x.arrExpected) })}</span>
          ${delayBadge(x)}
        </span>`,
      )
      .join('');
    if (!next) {
      const none = when ? 'home.noneAfter' : routeMode(route) === 'bus' ? 'home.noBuses' : 'home.noTrains';
      main.innerHTML = `<span class="muted">${t(none)}</span>`;
      return;
    }
    main.innerHTML = `<span class="big-time">${struck(next, hhmm(next.depPlanned))}</span>${delayBadge(next)}`;
    // Arrival of that train: the timetable one, struck through when the real one differs.
    el('arr').innerHTML =
      next.status !== 'cancelled' && shift(next.arrPlanned, next.arrExpected)
        ? `<s>${hhmm(next.arrPlanned)}</s> ${hhmm(next.arrExpected)}`
        : struck(next, hhmm(next.arrPlanned));
    el('actual').innerHTML = actualLine(
      next,
      atStop(next),
      { time: hhmm(next.depExpected) },
      shift(next.depPlanned, next.depExpected),
    );
    count.textContent = showCountdown(next.depExpected) ? countdown(next) : '';
    count.hidden = !count.textContent;
    const later = upcoming.slice(1, 3).map((x) => struck(x, hhmm(x.depPlanned)));
    // The platform (or the bus line) leads the last line, so the name on top has the whole width.
    then.innerHTML = [
      next.mode === 'bus' ? esc(next.number) : next.platform ? platformText(next) : '',
      later.length ? t('home.then', { times: later.join(' · ') }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    // A cancelled train does not make its route the soonest one.
    const running = upcoming.find((x) => x.status !== 'cancelled');
    if (running) departures.set(route.id, running.depExpected);
    else departures.delete(route.id);
    highlightSoonest(departures);
  };
  try {
    const { from, to } = await resolvedRoute(route);
    const { trips } = await findTrains(from, to, {
      max: 3,
      // A picked moment lists the departures from then on, as the route page does for a time range.
      window: when ? { start: when, end: when + HOURS_AFTER } : null,
      onUpdate: (partial) => partial.length && show(partial),
    });
    show(trips);
  } catch {
    const main = el('next');
    if (main) main.innerHTML = `<span class="muted">${t('home.unavailable')}</span>`;
  }
}

/* ---------- New route ---------- */

// Icon telling train stations from bus stops.
const modeIcon = (mode) =>
  `<span class="mode mode-${mode === 'bus' ? 'bus' : 'train'}" title="${t(mode === 'bus' ? 'mode.bus' : 'mode.train')}">${mode === 'bus' ? icons.bus : icons.train}</span>`;

// wantedMode() returns the only kind of stop that can be picked, or null for any.
// search defaults to every source; the planner passes its STA-only search.
function stationPicker(input, list, onPick, wantedMode = () => null, search = searchStations) {
  let timer = null;
  let query = 0;

  input.addEventListener('input', () => {
    onPick(null);
    clearTimeout(timer);
    const text = input.value;
    if (text.trim().length < 2) {
      list.innerHTML = '';
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++query;
      try {
        const found = (await search(text)).slice(0, 12);
        if (mine !== query) return;
        const wanted = wantedMode();
        const only = wanted === 'bus' ? 'new.onlyBus' : 'new.onlyTrain';
        // Stops of the other kind stay listed but dimmed, with a line saying why.
        const blocked = wanted && found.some((s) => s.mode !== wanted);
        list.innerHTML = found.length
          ? (blocked ? `<li class="hint">${t(only)}</li>` : '') +
            found
              .map((s, i) => {
                const sources = ['vt', 'sta'].filter((k) => s[k]).map((k) => SOURCE_NAMES[k]);
                const off = wanted && s.mode !== wanted ? 'class="off" aria-disabled="true"' : '';
                return `<li><button type="button" data-i="${i}" ${off}>${modeIcon(s.mode)}<span>${esc(s.name)}</span><small>${sources.join(' · ')}</small></button></li>`;
              })
              .join('')
          : `<li class="hint">${t('new.noResults')}</li>`;
        list.querySelectorAll('button').forEach((b) =>
          b.addEventListener('click', () => {
            if (b.classList.contains('off')) return toast(t(only));
            const s = found[Number(b.dataset.i)];
            input.value = s.name;
            list.innerHTML = '';
            onPick(s);
          }),
        );
      } catch (err) {
        if (mine === query) list.innerHTML = `<li class="hint">${esc(errText(err))}</li>`;
      }
    }, 250);
  });

  // Pressing a result must not blur the field first, or the list could close before the click lands.
  list.addEventListener('pointerdown', (event) => event.preventDefault());
  input.addEventListener('blur', () => setTimeout(() => (list.innerHTML = ''), 200));
}

function renderNew() {
  view.innerHTML = `
    ${pageHead(t('new.title'))}
    <form id="route-form" class="form card" autocomplete="off" novalidate>
      <div class="field">
        <label for="from">${t('new.from')}</label>
        <input id="from" placeholder="${t('new.fromPh')}" enterkeyhint="next">
        <ul class="suggestions" id="from-list"></ul>
      </div>
      <div class="field">
        <label for="to">${t('new.to')}</label>
        <input id="to" placeholder="${t('new.toPh')}" enterkeyhint="next">
        <ul class="suggestions" id="to-list"></ul>
      </div>
      <div class="field">
        <label for="name">${t('new.name')}</label>
        <input id="name" placeholder="${t('new.namePh')}" enterkeyhint="done">
      </div>
      ${colorPicker(null)}
      <p class="form-error" id="form-error"></p>
      <button class="btn primary block" type="submit">${t('new.save')}</button>
    </form>`;

  const picked = { from: null, to: null };
  const $ = (id) => view.querySelector(`#${id}`);
  // Once one end is picked, the other must be the same kind: a route is all train or all bus.
  stationPicker($('from'), $('from-list'), (s) => (picked.from = s), () => picked.to?.mode ?? null);
  stationPicker($('to'), $('to-list'), (s) => (picked.to = s), () => picked.from?.mode ?? null);

  $('route-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const error = $('form-error');
    const { from, to } = picked;
    if (!from || !to) return (error.textContent = t('new.pickError'));
    if (from.mode !== to.mode) return (error.textContent = t('new.modeError'));
    if ((from.vt && from.vt === to.vt) || (from.sta && from.sta === to.sta)) {
      return (error.textContent = t('new.sameError'));
    }
    const name = $('name').value.trim() || path(from, to);
    await save(() => store.addRoute({ name, from, to, color: pickedColor(view) }));
    location.hash = '#/';
  });
}

/* ---------- Route: current train and the following ones ---------- */

// Where the marker sits on the line, 0..1, or null while the train has not reached the first station.
function progress(trip) {
  const stops = trip.stops;
  const n = stops.length;
  const here = stops.findIndex((s) => s.here);
  if (here >= 0) return here / (n - 1);
  const last = stops.findLastIndex((s) => s.passed);
  if (last < 0) return null;
  const leave = stops[last].dep ?? stops[last].arr;
  const reach = stops[last + 1].arr ?? stops[last + 1].dep;
  const f = leave && reach > leave ? Math.min(0.9, Math.max(0.1, (Date.now() - leave) / (reach - leave))) : 0.5;
  return (last + f) / (n - 1);
}

function track(trip) {
  const n = trip.stops.length;
  if (n < 2) return '';
  const cancelled = trip.status === 'cancelled';
  const p = cancelled ? null : progress(trip);
  const before = !cancelled && p == null;
  const fill = (p ?? 0) * 100;
  const dots = trip.stops
    .map(
      (s, k) =>
        `<span class="dot ${s.passed || s.here ? 'passed' : ''} ${k === 0 || k === n - 1 ? 'end' : ''}" style="left:${(k / (n - 1)) * 100}%" title="${esc(s.name)}"></span>`,
    )
    .join('');
  const marker =
    p != null
      ? `<span class="marker" style="left:${fill}%">${icons.train}</span>`
      : before
        ? `<span class="marker before">${icons.train}</span>`
        : '';
  return `
    <div class="track ${before ? 'is-before' : ''} ${cancelled ? 'is-cancelled' : ''}" aria-hidden="true">
      <span class="rail"></span><span class="rail-fill" style="width:${fill}%"></span>${dots}${marker}
    </div>`;
}

function position(trip, from) {
  if (trip.status === 'cancelled') return t(trip.mode === 'bus' ? 'pos.busCancelled' : 'pos.cancelled');
  const stops = trip.stops;
  const here = stops.findIndex((s) => s.here);
  const last = stops.findLastIndex((s) => s.passed);
  let text;
  if (here >= 0) text = t('pos.at', { station: strong(stops[here].name) });
  else if (last >= 0) text = t('pos.between', { a: strong(stops[last].name), b: strong(stops[last + 1].name) });
  else if (trip.lastStation) return t('pos.lastSeen', { station: strong(trip.lastStation), time: hhmm(trip.lastSeen) });
  else if (trip.notStarted && trip.origin) return t('pos.notStarted', { station: strong(trip.origin) });
  else text = t('pos.notYet', { station: strong(from.name) });

  let sub = '';
  if (trip.source === 'vt' && trip.lastStation) sub = t('pos.lastSeen', { station: esc(trip.lastStation), time: hhmm(trip.lastSeen) });
  else if (trip.source === 'sta') sub = t(trip.realtime ? 'pos.estimated' : 'pos.scheduledOnly');
  return sub ? `${text}<span class="sub">${sub}</span>` : text;
}

// The whole line when known, with the stops outside the trip dimmed.
function stopList(trip) {
  return `<ol class="stop-list">${(knownRoute(trip) ?? trip.stops)
    .map(
      (s) => `
      <li class="${s.passed ? 'passed' : ''} ${s.here ? 'here' : ''} ${s.outside ? 'outside' : ''}">
        <span class="stop-time">${time(s.planned, s.arr ?? s.dep)}</span>
        <span class="stop-name">${esc(s.name)}</span>
      </li>`,
    )
    .join('')}</ol>`;
}

function trainFacts(trip) {
  const parts = [
    esc(trip.number),
    trip.operator && esc(trip.operator),
    trip.change ? t('train.change', { station: esc(trip.change) }) : t('train.to', { station: esc(trip.destination) }),
    platformText(trip),
  ];
  return parts.filter(Boolean).join(' · ');
}

function hero(trip, from, to) {
  const label = trip.status === 'travelling' ? t('train.onTheWay') : t('train.next');
  return `
    <article class="hero ${trip.status === 'cancelled' ? 'cancelled' : ''}">
      <div class="hero-top"><span>${label} · ${esc(trip.number)}</span><span>${countdown(trip)}</span></div>
      <div class="hero-times">
        <div>
          <span class="time">${hhmm(trip.depPlanned)}</span><span class="station">${esc(from.name)}</span>
          ${actualLine(
            trip,
            trip.status === 'travelling' ? 'time.departed' : 'time.departs',
            { time: hhmm(trip.depExpected) },
            shift(trip.depPlanned, trip.depExpected),
          )}
        </div>
        ${delayBadge(trip)}
        <div class="right">
          <span class="time">${hhmm(trip.arrPlanned)}</span><span class="station">${esc(to.name)}</span>
          ${actualLine(trip, atStop(trip), { time: hhmm(trip.arrExpected) }, shift(trip.arrPlanned, trip.arrExpected))}
        </div>
      </div>
      ${track(trip)}
      <p class="where">${position(trip, from)}</p>
      <div class="facts"><span>${trainFacts(trip)}</span>${sourceChip(trip)}</div>
      ${
        trip.note ? `<p class="note">${esc(trip.note)}</p>` : ''
      }
      <details class="stops" data-key="${esc(trip.key)}">
        <summary>${t('train.stops', { n: trip.stops.length })}${icons.chevron}</summary>
        ${stopList(trip)}
      </details>
    </article>`;
}

function row(trip, from, to) {
  // Each part wraps as a whole, never inside a train number or a duration.
  const sub = [countdown(trip), esc(trip.number)].filter(Boolean).map((s) => `<span class="nowrap">${s}</span>`).join(' · ');
  // Only the times that differ from the timetable, so the row stays short.
  const depShift = shift(trip.depPlanned, trip.depExpected);
  const arrShift = shift(trip.arrPlanned, trip.arrExpected);
  const [key, vars] =
    depShift && arrShift
      ? ['time.both', { dep: hhmm(trip.depExpected), arr: hhmm(trip.arrExpected) }]
      : depShift
        ? ['time.departs', { time: hhmm(trip.depExpected) }]
        : ['time.arrives', { time: hhmm(trip.arrExpected) }];
  const actual = actualLine(trip, key, vars, depShift || arrShift);
  return `
    <details class="train-row ${trip.status === 'cancelled' ? 'cancelled' : ''}" data-key="${esc(trip.key)}">
      <summary>
        <span class="row-line">
          <span class="row-time">${hhmm(trip.depPlanned)}</span>
          <span class="row-title">→ ${esc(to.name)} ${hhmm(trip.arrPlanned)}</span>
          <span class="row-chevron">${icons.chevron}</span>
        </span>
        <span class="row-line">
          <span class="row-sub">${sub}</span>
          ${delayBadge(trip, true)}
        </span>
        ${actual}
      </summary>
      <div class="row-body">
        ${track(trip)}
        <p class="where">${position(trip, from)}</p>
        <div class="facts"><span>${trainFacts(trip)}</span>${sourceChip(trip)}</div>
        ${trip.note ? `<p class="note">${esc(trip.note)}</p>` : ''}
        ${stopList(trip)}
      </div>
    </details>`;
}

function renderRoute(id, reversed) {
  const route = store.getRoute(id);
  if (!route) {
    location.hash = '#/';
    return;
  }
  const p = reversed ? path(route.to, route.from) : path(route.from, route.to);
  // A custom name like "Home → Work" no longer fits once the direction is swapped.
  const title = reversed ? p : route.name;

  view.innerHTML = `
    ${pageHead(
      title,
      title === p ? '' : p,
      `<a class="icon-btn" href="#/route/${esc(id)}${reversed ? '' : '/r'}" aria-label="${t('route.invert')}" title="${t('route.invert')}">${icons.swap}</a>
       <button class="icon-btn" type="button" id="refresh" aria-label="${t('route.refresh')}" title="${t('route.refresh')}">${icons.refresh}</button>`,
    )}
    <div class="chips" id="when">
      <button type="button" class="chip on" data-when="now">${t('when.now')}</button>
      <button type="button" class="chip" data-when="pick">${icons.calendar}${t('when.pick')}</button>
    </div>
    <form class="when-form card" id="when-form" hidden>
      <label class="when-day">${t('when.day')}<input type="date" id="when-day" required></label>
      <label>${t('when.from')}<input type="time" id="when-from" required></label>
      <label>${t('when.to')}<input type="time" id="when-to" required></label>
    </form>
    <p class="meta" id="updated"></p>
    <div id="trains"><div class="hero placeholder"><span class="skeleton"></span></div></div>
    <div class="card settings-block" id="color">${colorPicker(route.color)}</div>
    <button class="link-danger" type="button" id="delete">${t('route.delete')}</button>`;

  const ticket = renderTicket;
  const list = view.querySelector('#trains');
  const updated = view.querySelector('#updated');
  const refreshBtn = view.querySelector('#refresh');
  let stations = null;
  let shown = new Map();
  // null means "now": the featured next departure. Otherwise every departure between start and end.
  let range = null;

  // Opening a stop list fetches the rest of the line when the source did not send it.
  list.addEventListener(
    'toggle',
    async (event) => {
      const details = event.target;
      const trip = shown.get(details.dataset?.key);
      if (!details.open || !trip || knownRoute(trip)) return;
      if (!(await loadRoute(trip)) || !details.isConnected) return;
      details.querySelector('.stop-list').outerHTML = stopList(trip);
    },
    true,
  );

  const show = (trips, from, to) => {
    if (ticket !== renderTicket) return;
    shown = new Map(trips.map((x) => [x.key, x]));
    // Keep expanded trains expanded across refreshes.
    const open = new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.key));
    // The next departure is featured, as on the home card; trains already on their way get their own list.
    // With no departure left, the first train on its way is featured instead.
    const travelling = trips.filter((x) => x.status === 'travelling');
    const upcoming = trips.filter((x) => x.status !== 'travelling');
    const featured = upcoming[0] ?? travelling[0];
    const section = (title, items) =>
      items.length ? `<h2 class="list-title">${title}</h2><div class="rows">${items.map((x) => row(x, from, to)).join('')}</div>` : '';
    if (range) {
      list.innerHTML = trips.length
        ? `<div class="rows">${trips.map((x) => row(x, from, to)).join('')}</div>`
        : `<p class="empty">${t('when.none')}</p>`;
      list.querySelectorAll('details').forEach((d) => (d.open = open.has(d.dataset.key)));
      return;
    }
    list.innerHTML = featured
      ? `${hero(featured, from, to)}
         ${section(t('train.onTheWay'), travelling.filter((x) => x !== featured))}
         ${section(t('route.upcoming'), upcoming.filter((x) => x !== featured))}`
      : `<p class="empty">${t('route.none')}</p>`;
    list.querySelectorAll('details').forEach((d) => (d.open = open.has(d.dataset.key)));
  };

  const load = async () => {
    refreshBtn.classList.add('spinning');
    updated.textContent = t('route.updating');
    try {
      stations ??= await resolvedRoute(route);
      const from = reversed ? stations.to : stations.from;
      const to = reversed ? stations.from : stations.to;
      const asked = range;
      const { trips, errors } = await findTrains(from, to, {
        window: range,
        onUpdate: (partial) => asked === range && partial.length && show(partial, from, to),
      });
      if (asked !== range) return;
      if (ticket !== renderTicket) return;
      show(trips, from, to);
      const down = Object.keys(errors).map((k) => t('route.sourceDown', { source: SOURCE_NAMES[k] }));
      updated.textContent = [t('route.updated', { time: hhmm(Date.now()) }), ...down].join(' · ');
    } catch (err) {
      if (ticket !== renderTicket) return;
      list.innerHTML = `<div class="error-box">${esc(errText(err))}</div>`;
      updated.textContent = '';
    } finally {
      refreshBtn.classList.remove('spinning');
    }
  };

  refreshBtn.addEventListener('click', load);

  // "Now" or a day with a time range; the range defaults to the next two hours.
  const form = view.querySelector('#when-form');
  const day = view.querySelector('#when-day');
  const fromTime = view.querySelector('#when-from');
  const toTime = view.querySelector('#when-to');
  // Opened from a home showing another moment: start from that moment.
  const now = new Date(when ?? Date.now());
  const later = new Date(now.getTime() + 2 * 60 * 60_000);
  day.value = dayValue(now);
  fromTime.value = timeValue(now);
  toTime.value = later.getDate() === now.getDate() ? timeValue(later) : '23:59';

  const applyWindow = () => {
    if (!day.value || !fromTime.value || !toTime.value) return;
    const start = new Date(`${day.value}T${fromTime.value}`).getTime();
    let end = new Date(`${day.value}T${toTime.value}`).getTime();
    // "22:00 to 01:00" runs past midnight.
    if (end <= start) end += 24 * 60 * 60_000;
    range = { start, end };
    list.innerHTML = '<div class="hero placeholder"><span class="skeleton"></span></div>';
    load();
  };
  [day, fromTime, toTime].forEach((input) => input.addEventListener('change', applyWindow));
  view.querySelectorAll('[data-when]').forEach((chip) =>
    chip.addEventListener('click', () => {
      const pick = chip.dataset.when === 'pick';
      view.querySelectorAll('[data-when]').forEach((c) => c.classList.toggle('on', c === chip));
      form.hidden = !pick;
      if (pick) return applyWindow();
      range = null;
      load();
    }),
  );

  view.querySelector('#color').addEventListener('change', () => save(() => store.updateRoute(route.id, { color: pickedColor(view) })));

  view.querySelector('#delete').addEventListener('click', (event) => {
    if (!confirmTap(event.currentTarget, esc(t('route.deleteConfirm')))) return;
    // The route is gone from the list at once; the Drive write may still be running (or waiting for a sign-in).
    save(() => store.removeRoute(route.id));
    location.hash = '#/';
  });

  if (when) view.querySelector('[data-when=pick]').click();
  else load();
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, config.refreshSeconds * 1000);
}

/* ---------- Plan: the best way between two places, train, bus or both ---------- */

// Plans shown the other way round, until the app is reloaded.
const reversedPlans = new Set();

const minutesBetween = (a, b) => Math.round((b - a) / 60_000);

function changesText(j) {
  if (!j.changes) return t('plan.direct');
  return j.changes === 1 ? t('plan.change1') : t('plan.changes', { n: j.changes });
}

// The badge of the whole journey: cancelled, or the delay at the destination.
const journeyBadge = (j, compact = false) =>
  delayBadge({ status: j.cancelled ? 'cancelled' : 'waiting', delay: j.delay, notStarted: false }, compact);

// What breaks a journey or makes it risky, worst first.
function problems(j) {
  return [
    ...j.legs.filter((l) => l.cancelled).map((l) => ({ level: 'bad', text: t('plan.cancelled', { name: esc(l.name) }) })),
    ...j.transfers.filter((x) => x.missed).map((x) => ({ level: 'bad', text: t('plan.missed', { station: esc(x.at) }) })),
    ...j.transfers.filter((x) => x.tight).map((x) => ({ level: 'warn', text: t('plan.tight', { station: esc(x.at) }) })),
  ];
}

const problemLines = (j) =>
  problems(j)
    .map((p) => `<span class="actual ${p.level === 'bad' ? 'bad' : 'late'}">${p.text}</span>`)
    .join('');

// "Bus 201" -> "201": the icon already says it is a bus.
const legChips = (j) =>
  j.legs
    .map(
      (l) =>
        `<span class="leg-chip leg-${l.mode} ${l.cancelled ? 'off' : ''}">${l.mode === 'bus' ? icons.bus : icons.train}${esc(l.mode === 'bus' ? l.name.replace(/^Bus\s+/, '') : l.name)}</span>`,
    )
    .join('<span class="leg-sep" aria-hidden="true">›</span>');

// Real departure and arrival when they differ from the timetable.
function journeyActual(j) {
  if (j.cancelled) return '';
  const dep = shift(j.depPlanned, j.depExpected);
  const arr = shift(j.arrPlanned, j.arrExpected);
  if (!dep && !arr) return '';
  const [key, vars] =
    dep && arr
      ? ['time.both', { dep: hhmm(j.depExpected), arr: hhmm(j.arrExpected) }]
      : dep
        ? ['time.departs', { time: hhmm(j.depExpected) }]
        : ['time.arrives', { time: hhmm(j.arrExpected) }];
  return `<span class="actual ${(dep || arr) > 0 ? 'late' : 'early'}">${t(key, vars)}</span>`;
}

// Every ride with where to get on and off, and the changes between them.
function legList(j) {
  const items = j.legs.map((l, i) => {
    // Each part wraps as a whole; CSS puts the dots between them.
    const ride = [
      `${modeIcon(l.mode)}<strong>${esc(l.name)}</strong>`,
      l.towards && t('plan.towards', { station: esc(l.towards) }),
      l.mode === 'train' && l.platform && t('train.platform', { platform: esc(l.platform) }),
    ]
      .filter(Boolean)
      .map((s) => `<span>${s}</span>`)
      .join('');
    const board = `
      <li class="${l.cancelled ? 'off' : ''}">
        <span class="stop-time">${time(l.depPlanned, l.depExpected)}</span>
        <span class="stop-name">${esc(l.from)}<span class="leg-ride">${ride}</span>${l.cancelled ? delayBadge({ status: 'cancelled' }) : ''}</span>
      </li>`;
    const x = j.transfers[i];
    if (!x) return board;
    const walk = x.walk ? `<span>${icons.walk}${t('plan.walk', { n: x.walk })}</span>` : '';
    const level = x.missed ? 'bad' : x.tight ? 'warn' : '';
    return `${board}
      <li class="leg-change ${level}">
        <span class="stop-time">${time(l.arrPlanned, l.arrExpected)}</span>
        <span class="stop-name">${esc(l.to)}<span class="leg-ride"><span>${t('plan.transfer', { station: esc(x.at), wait: duration(Math.max(0, x.spare + x.walk)) })}</span>${walk}</span></span>
      </li>`;
  });
  const last = j.legs[j.legs.length - 1];
  items.push(`
    <li class="leg-end">
      <span class="stop-time">${time(last.arrPlanned, last.arrExpected)}</span>
      <span class="stop-name"><strong>${esc(last.to)}</strong></span>
    </li>`);
  return `<ol class="stop-list leg-list">${items.join('')}</ol>`;
}

function bestBlock(j) {
  const count = showCountdown(j.depExpected) ? countdown({ status: 'waiting', depExpected: j.depExpected }) : '';
  return `
    <div class="plan-best">
      <div class="plan-label">
        <span class="best-tag">${icons.star}${t('plan.best')}</span>
        ${count ? `<span class="pill rc-count">${count}</span>` : ''}
      </div>
      <div class="plan-times">
        <span class="big-time">${hhmm(j.depPlanned)}</span><span class="plan-arrow">→</span><span class="big-time">${hhmm(j.arrPlanned)}</span>
        ${journeyBadge(j)}
      </div>
      ${journeyActual(j)}${problemLines(j)}
      <div class="legs">${legChips(j)}</div>
      <p class="plan-meta">${duration(minutesBetween(j.depExpected, j.arrExpected))} · ${changesText(j)}</p>
      <details class="stops plan-details" data-key="${esc(j.key)}">
        <summary>${t('plan.details')}${icons.chevron}</summary>
        ${legList(j)}
      </details>
    </div>`;
}

function journeyRow(j) {
  return `
    <details class="train-row ${j.ok ? '' : 'cancelled'}" data-key="${esc(j.key)}">
      <summary>
        <span class="row-line">
          <span class="row-time">${hhmm(j.depPlanned)}</span>
          <span class="row-title">→ ${hhmm(j.arrPlanned)} · ${duration(minutesBetween(j.depExpected, j.arrExpected))}</span>
          <span class="row-chevron">${icons.chevron}</span>
        </span>
        <span class="row-line">
          <span class="row-sub legs">${legChips(j)}</span>
          ${journeyBadge(j, true)}
        </span>
        ${journeyActual(j)}${problemLines(j)}
      </summary>
      <div class="row-body">${legList(j)}</div>
    </details>`;
}

const planEnds = (p) => (reversedPlans.has(p.id) ? [p.to, p.from] : [p.from, p.to]);

function planCard(p) {
  const id = esc(p.id);
  const [a, b] = planEnds(p);
  const reversed = reversedPlans.has(p.id);
  const title = reversed ? path(a, b) : p.name;
  return `
    <li class="plan-card" id="plan-${id}">
      <div class="plan-head">
        <div class="plan-title">
          <span class="rc-name">${esc(title)}</span>
          ${title !== path(a, b) ? `<span class="rc-path">${esc(path(a, b))}</span>` : ''}
        </div>
        <button class="icon-btn" type="button" data-swap="${id}" aria-label="${t('route.invert')}" title="${t('route.invert')}">${icons.swap}</button>
        <button class="icon-btn" type="button" data-remove="${id}" aria-label="${t('plan.delete')}" title="${t('plan.delete')}">${icons.close}</button>
      </div>
      <div class="plan-body" id="planbody-${id}"><span class="skeleton"></span></div>
    </li>`;
}

async function loadPlan(p, ticket) {
  const reversed = reversedPlans.has(p.id);
  const [a, b] = planEnds(p);
  const body = () => {
    const el = ticket === renderTicket && reversed === reversedPlans.has(p.id) && document.getElementById(`planbody-${p.id}`);
    return el || null;
  };
  let html;
  try {
    const { journeys, best } = await planJourneys(a, b, { at: when });
    const others = journeys.filter((j) => j !== best).slice(0, 4);
    html = !journeys.length
      ? `<p class="muted">${t('plan.none')}</p>`
      : `${best ? bestBlock(best) : `<div class="error-box">${t('plan.noneOk')}</div>`}
         ${others.length ? `<h3 class="list-title">${t('plan.others')}</h3><div class="rows">${others.map(journeyRow).join('')}</div>` : ''}`;
  } catch (err) {
    html = `<p class="muted">${esc(errText(err))}</p>`;
  }
  const el = body();
  if (!el) return;
  // Keep expanded journeys expanded across refreshes.
  const open = new Set([...el.querySelectorAll('details[open]')].map((d) => d.dataset.key));
  el.innerHTML = html;
  el.querySelectorAll('details').forEach((d) => (d.open = open.has(d.dataset.key)));
}

function renderPlan() {
  const list = plans.getPlans();
  view.innerHTML = `
    <header class="hello">
      <div>
        <p class="hello-date">${when ? today() : t('plan.subtitle')}</p>
        <h1>${t('plan.title')}</h1>
      </div>
    </header>
    ${list.length ? `${whenBar()}<ul class="plans">${list.map(planCard).join('')}</ul>` : `<p class="muted plan-empty">${t('plan.empty')}</p>`}
    <form id="plan-form" class="form card plan-form" autocomplete="off" novalidate>
      <h2>${t('plan.add')}</h2>
      <div class="field">
        <label for="from">${t('new.from')}</label>
        <input id="from" placeholder="${t('new.fromPh')}" enterkeyhint="next">
        <ul class="suggestions" id="from-list"></ul>
      </div>
      <div class="field">
        <label for="to">${t('new.to')}</label>
        <input id="to" placeholder="${t('new.toPh')}" enterkeyhint="next">
        <ul class="suggestions" id="to-list"></ul>
      </div>
      <div class="field">
        <label for="name">${t('new.name')}</label>
        <input id="name" placeholder="${t('new.namePh')}" enterkeyhint="done">
      </div>
      <p class="form-error" id="form-error"></p>
      <button class="btn primary block" type="submit">${icons.plus}${t('plan.save')}</button>
      <p class="muted small">${t('plan.stopsOnly')}</p>
    </form>
    <button class="fab" type="button" id="plan-add" aria-label="${t('plan.add')}" title="${t('plan.add')}">${icons.plus}</button>`;

  const ticket = renderTicket;
  const $ = (id) => view.querySelector(`#${id}`);
  if (list.length) bindWhen(render);

  // The floating "+" brings up the form at the bottom, ready to type.
  $('plan-add').addEventListener('click', () => {
    $('plan-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('from').focus({ preventScroll: true });
  });

  const picked = { from: null, to: null };
  stationPicker($('from'), $('from-list'), (s) => (picked.from = s), () => null, searchStops);
  stationPicker($('to'), $('to-list'), (s) => (picked.to = s), () => null, searchStops);
  $('plan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { from, to } = picked;
    if (!from || !to) return ($('form-error').textContent = t('new.pickError'));
    if (from.sta === to.sta) return ($('form-error').textContent = t('new.sameError'));
    const name = $('name').value.trim() || path(from, to);
    await save(() => plans.addPlan({ name, from, to }));
    render();
  });

  view.querySelector('.plans')?.addEventListener('click', (event) => {
    const swap = event.target.closest('[data-swap]');
    const remove = event.target.closest('[data-remove]');
    const p = list.find((x) => x.id === (swap ?? remove)?.dataset[swap ? 'swap' : 'remove']);
    if (!p) return;
    if (remove) {
      if (!confirmTap(remove, `${icons.close}${esc(t('plan.deleteConfirm'))}`)) return;
      // Gone from the list at once, as for routes; the Drive write follows.
      save(() => plans.removePlan(p.id));
      return render();
    }
    if (reversedPlans.has(p.id)) reversedPlans.delete(p.id);
    else reversedPlans.add(p.id);
    document.getElementById(`plan-${p.id}`).outerHTML = planCard(p);
    loadPlan(p, ticket);
  });

  list.forEach((p) => loadPlan(p, ticket));
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') list.forEach((p) => loadPlan(p, ticket));
  }, config.refreshSeconds * 1000);
}

/* ---------- Settings ---------- */

function segmented(name, options, value) {
  return `
    <div class="segmented" role="radiogroup">
      ${Object.entries(options)
        .map(
          ([key, label]) => `
        <label>
          <input type="radio" name="${name}" value="${key}" ${key === value ? 'checked' : ''}>
          <span>${esc(label)}</span>
        </label>`,
        )
        .join('')}
    </div>`;
}

function installBlock() {
  const state = pwa.installState();
  if (state === 'available') return `<button class="btn primary" type="button" id="install">${t('install.button')}</button>`;
  return `<p class="muted">${t(`install.${state}`)}</p>`;
}

function avatar(u) {
  const initial = esc((u.name || u.email).charAt(0).toUpperCase());
  return u.picture
    ? `<img class="avatar" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer" width="44" height="44">`
    : `<span class="avatar">${initial}</span>`;
}

function renderSettings() {
  const s = settings.getSettings();
  const user = google.getUser();
  const sheet = user && google.spreadsheetUrl();
  const themes = Object.fromEntries(settings.THEMES.map((k) => [k, t(`theme.${k}`)]));

  view.innerHTML = `
    <header class="hello"><h1>${t('settings.title')}</h1></header>

    <div class="card settings-block">
      <h2>${t('settings.account')}</h2>
      ${
        user
          ? `<div class="account">
               ${avatar(user)}
               <div class="account-who">
                 <strong>${esc(user.name)}</strong>
                 <span class="muted small">${esc(user.email)}</span>
               </div>
             </div>
             <p class="muted">${t('settings.driveInfo')}</p>
             <div class="row">
               ${sheet ? `<a class="btn" href="${esc(sheet)}" target="_blank" rel="noopener">${t('settings.openSheet')}</a>` : ''}
               <button class="btn" type="button" id="sign-out">${t('settings.signOut')}</button>
             </div>`
          : `<p class="muted">${t('settings.localInfo')}</p>
             <button class="btn primary" type="button" id="sign-in">${t('settings.signIn')}</button>`
      }
    </div>

    <div class="card settings-block">
      <h2>${t('settings.language')}</h2>
      ${segmented('lang', LANGUAGES, s.lang)}
    </div>

    <div class="card settings-block">
      <h2>${t('settings.theme')}</h2>
      ${segmented('theme', themes, s.theme)}
    </div>

    <div class="card settings-block">
      <h2>${t('settings.install')}</h2>
      <div id="install-block">${installBlock()}</div>
    </div>

    <p class="muted small footnote">${t('settings.sources')}</p>`;

  view.querySelectorAll('input[type=radio]').forEach((input) =>
    input.addEventListener('change', async () => {
      await save(() => settings.updateSettings({ [input.name]: input.value }));
      renderNav();
      renderSettings();
    }),
  );

  view.querySelector('#sign-in')?.addEventListener('click', () =>
    run(async () => {
      await google.signInWithProfile();
      await syncDrive();
      toast(t('settings.synced'));
      render();
    }),
  );

  view.querySelector('#sign-out')?.addEventListener('click', () => {
    google.signOut();
    render();
  });

  bindInstall();
}

function bindInstall() {
  view.querySelector('#install')?.addEventListener('click', async () => {
    if (await pwa.install()) toast(t('install.done'));
  });
}

pwa.onInstallChange(() => {
  const block = view.querySelector('#install-block');
  if (!block) return;
  block.innerHTML = installBlock();
  bindInstall();
});

/* ---------- Navigation ---------- */

function renderNav(page = 'home') {
  const items = {
    home: [icons.route, t('nav.routes')],
    plan: [icons.plan, t('nav.plan')],
    new: [icons.plus, t('nav.new')],
    settings: [icons.settings, t('nav.settings')],
  };
  nav.querySelectorAll('[data-page]').forEach((link) => {
    const [icon, label] = items[link.dataset.page];
    link.innerHTML = `${icon}<span>${label}</span>`;
    link.setAttribute('aria-label', label);
    link.classList.toggle('active', link.dataset.page === page);
  });
  // Decides where the floating "+" shows on phones (see .nav-add in the CSS).
  nav.dataset.page = page;
}

function render() {
  renderTicket++;
  clearInterval(refreshTimer);
  refreshTimer = null;
  const [, page, id, flag] = location.hash.split('/');
  if (page === 'new') renderNew();
  else if (page === 'settings') renderSettings();
  else if (page === 'plan') renderPlan();
  else if (page === 'route' && id) renderRoute(id, flag === 'r');
  else renderHome();
  renderNav(['new', 'settings', 'plan'].includes(page) ? page : 'home');
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => {
  reordering = false;
  render();
});
settings.applySettings();
render();

/* ---------- Drive sync for a remembered sign-in ---------- */

async function syncDrive() {
  await Promise.all([store.syncFromDrive(), plans.syncFromDrive(), settings.syncWithDrive()]);
}

// Pull what other devices changed. Not while a new route or plan is being typed: re-rendering would clear the form.
async function syncAndRefresh() {
  try {
    await syncDrive();
  } catch {
    return;
  }
  const typing = location.hash.startsWith('#/plan') && view.querySelector('#plan-form input:not(:placeholder-shown)');
  if (!location.hash.startsWith('#/new') && !typing) {
    renderNav();
    render();
  }
}

if (google.isSignedIn()) {
  if (google.isConnected()) {
    syncAndRefresh();
  } else {
    // An expired token can only be renewed after a click or tap, so wait for the first one
    // (but not "Sign out": no point opening Google's window just to leave).
    const renewOnFirstTap = async (event) => {
      if (event.target.closest?.('#sign-out')) return;
      window.removeEventListener('pointerdown', renewOnFirstTap, true);
      if (google.isSignedIn() && (await google.reconnect())) syncAndRefresh();
    };
    window.addEventListener('pointerdown', renewOnFirstTap, true);
  }
}
