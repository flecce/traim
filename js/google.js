import { config } from './config.js';
import { AppError } from './errors.js';

// drive.file only grants access to files this app created, so the spreadsheet stays isolated.
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
export const TABS = { routes: 'Routes', settings: 'Settings' };

let tokenClient = null;
let pending = null;
let token = null;
let expiresAt = 0;
let spreadsheetId = null;
// Writes are serialized: each one clears and rewrites a whole tab.
let writeQueue = Promise.resolve();

export const isConfigured = () => Boolean(config.googleClientId);
export const isConnected = () => Boolean(token) && Date.now() < expiresAt;
export const spreadsheetUrl = () => spreadsheetId && `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

function settle(fn, value) {
  const p = pending;
  pending = null;
  p?.[fn](value);
}

export function signIn() {
  if (!isConfigured()) return Promise.reject(new AppError('error.googleNotConfigured'));
  if (!window.google?.accounts?.oauth2) return Promise.reject(new AppError('error.googleNotLoaded'));

  tokenClient ??= window.google.accounts.oauth2.initTokenClient({
    client_id: config.googleClientId,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) return settle('reject', new Error(resp.error_description || resp.error));
      token = resp.access_token;
      expiresAt = Date.now() + (Number(resp.expires_in) - 60) * 1000;
      settle('resolve');
    },
    error_callback: (err) => {
      settle('reject', err.type === 'popup_closed' ? new AppError('error.googleCancelled') : new Error(err.message || err.type));
    },
  });

  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

export function signOut() {
  if (token) window.google?.accounts?.oauth2?.revoke(token, () => {});
  token = null;
  expiresAt = 0;
  spreadsheetId = null;
}

async function gfetch(url, options = {}) {
  if (!isConnected()) throw new AppError('error.googleExpired');
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 401) {
    token = null;
    throw new AppError('error.googleExpired');
  }
  if (!res.ok) throw new AppError('error.googleStatus', { status: res.status });
  return res.status === 204 ? null : res.json();
}

export function getUser() {
  return gfetch('https://www.googleapis.com/oauth2/v3/userinfo');
}

const range = (r) => encodeURIComponent(r);

async function spreadsheet() {
  if (spreadsheetId) return spreadsheetId;
  const q = encodeURIComponent(
    `name='${config.spreadsheetName}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
  );
  const list = await gfetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
  const tabs = Object.values(TABS);

  if (list.files.length) {
    const id = list.files[0].id;
    const meta = await gfetch(`${SHEETS}/${id}?fields=sheets.properties.title`);
    const existing = new Set(meta.sheets.map((s) => s.properties.title));
    const missing = tabs.filter((tab) => !existing.has(tab));
    if (missing.length) {
      await gfetch(`${SHEETS}/${id}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }),
      });
    }
    spreadsheetId = id;
  } else {
    const created = await gfetch(SHEETS, {
      method: 'POST',
      body: JSON.stringify({
        properties: { title: config.spreadsheetName },
        sheets: tabs.map((title) => ({ properties: { title } })),
      }),
    });
    spreadsheetId = created.spreadsheetId;
  }
  return spreadsheetId;
}

// Rows below the header row.
export async function readRows(tab) {
  const id = await spreadsheet();
  const data = await gfetch(`${SHEETS}/${id}/values/${range(`${tab}!A2:Z`)}`);
  return data.values ?? [];
}

export function writeRows(tab, header, rows) {
  const write = async () => {
    const id = await spreadsheet();
    await gfetch(`${SHEETS}/${id}/values/${range(`${tab}!A:Z`)}:clear`, { method: 'POST' });
    await gfetch(`${SHEETS}/${id}/values/${range(`${tab}!A1`)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [header, ...rows] }),
    });
  };
  writeQueue = writeQueue.catch(() => {}).then(write);
  return writeQueue;
}
