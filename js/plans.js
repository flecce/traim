import * as google from './google.js';
import { readLocal, writeLocal } from './store.js';

// Journeys for the planner: just two STA stops, the best way between them is worked out live.
// Same storage as routes: on this device and, when signed in, in the "Plans" tab of the Drive sheet.
const PLANS_KEY = 'traim.plans';
const SYNCED_KEY = 'traim.syncedPlanIds';
const HEADER = ['id', 'name', 'from_name', 'from_sta', 'to_name', 'to_sta'];

const stop = (s) => ({ name: s.name, sta: s.sta, vt: null });
const normalize = (p) => ({ id: p.id, name: p.name, from: stop(p.from), to: stop(p.to) });

let plans = readLocal(PLANS_KEY, []).map(normalize);

export const getPlans = () => plans;

const newId = () => globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36);

const toRow = (p) => [p.id, p.name, p.from.name, p.from.sta, p.to.name, p.to.sta];

const fromRow = ([id, name, fromName, fromSta, toName, toSta]) => ({
  id,
  name: name || `${fromName} → ${toName}`,
  from: { name: fromName, sta: fromSta, vt: null },
  to: { name: toName, sta: toSta, vt: null },
});

// Saves locally and, when signed in, to Drive. Throws only if the Drive write fails.
async function persist() {
  writeLocal(PLANS_KEY, plans);
  if (!google.isSignedIn()) return;
  await google.writeRows(google.TABS.plans, HEADER, plans.map(toRow));
  writeLocal(SYNCED_KEY, plans.map((p) => p.id));
}

export async function addPlan(plan) {
  plans = [...plans, normalize({ id: newId(), ...plan })];
  await persist();
}

export async function removePlan(id) {
  plans = plans.filter((p) => p.id !== id);
  await persist();
}

// As for routes: plans only on this device are uploaded, ones deleted elsewhere disappear.
export async function syncFromDrive() {
  const remote = (await google.readRows(google.TABS.plans)).filter((r) => r[0] && r[3] && r[5]).map(fromRow);
  const remoteIds = new Set(remote.map((p) => p.id));
  const synced = new Set(readLocal(SYNCED_KEY, []));
  const localOnly = plans.filter((p) => !remoteIds.has(p.id) && !synced.has(p.id));
  plans = [...remote, ...localOnly];
  writeLocal(PLANS_KEY, plans);
  if (localOnly.length) await google.writeRows(google.TABS.plans, HEADER, plans.map(toRow));
  writeLocal(SYNCED_KEY, plans.map((p) => p.id));
}
