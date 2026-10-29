import * as google from './google.js';
import { detectLang, setLang } from './i18n.js';
import { readLocal, writeLocal } from './store.js';

const KEY = 'traim.settings';
const HEADER = ['key', 'value'];
export const THEMES = ['auto', 'light', 'dark'];

// updatedAt decides which copy wins when local and Drive settings meet: 0 means "never changed here".
let current = { lang: detectLang(), theme: 'auto', updatedAt: 0, ...readLocal(KEY, {}) };

export const getSettings = () => current;

export function applySettings() {
  setLang(current.lang);
  const root = document.documentElement;
  if (current.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = current.theme;
}

const toRows = (s) => Object.entries(s).map(([k, v]) => [k, String(v)]);

function fromRows(rows) {
  const map = Object.fromEntries(rows.filter((r) => r[0]));
  if (!map.updatedAt) return null;
  return { lang: map.lang, theme: map.theme, updatedAt: Number(map.updatedAt) };
}

// Saves locally and, when signed in, to Drive. Throws only if the Drive write fails.
export async function updateSettings(patch) {
  current = { ...current, ...patch, updatedAt: Date.now() };
  writeLocal(KEY, current);
  applySettings();
  if (google.isSignedIn()) await google.writeRows(google.TABS.settings, HEADER, toRows(current));
}

// On sign-in the newer copy wins; settings that only exist on this device are uploaded.
export async function syncWithDrive() {
  const remote = fromRows(await google.readRows(google.TABS.settings));
  if (remote && remote.updatedAt > current.updatedAt) {
    current = { ...current, ...remote };
    writeLocal(KEY, current);
    applySettings();
  } else if (!remote || current.updatedAt > remote.updatedAt) {
    await google.writeRows(google.TABS.settings, HEADER, toRows(current));
  }
}
