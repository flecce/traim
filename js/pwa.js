let deferredPrompt = null;
let listener = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Keep the prompt for the "Install" button in settings instead of the browser's mini-infobar.
  e.preventDefault();
  deferredPrompt = e;
  listener?.();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  listener?.();
});

export const onInstallChange = (fn) => (listener = fn);

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

// 'installed' | 'available' | 'ios' | 'unavailable'
export function installState() {
  if (isStandalone()) return 'installed';
  if (deferredPrompt) return 'available';
  if (isIos()) return 'ios';
  return 'unavailable';
}

export async function install() {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  listener?.();
  return outcome === 'accepted';
}

const registration =
  'serviceWorker' in navigator ? navigator.serviceWorker.register('sw.js').catch(() => null) : Promise.resolve(null);

/* ---------- New release: reload open pages ---------- */

const BUILD = document.querySelector('meta[name="traim-build"]')?.content ?? 'dev';
const RELOADED_KEY = 'traim.reloadedFor';
const CHECK_EVERY = 5 * 60_000;

async function checkForRelease() {
  let latest;
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    ({ build: latest } = await res.json());
  } catch {
    return;
  }
  if (!latest || latest === BUILD) return;
  // Don't throw away what the user is typing; the next check will try again.
  if (document.activeElement?.matches('input, textarea')) return;
  // If the page still comes back old (stale HTTP cache), reload only once per release.
  try {
    if (sessionStorage.getItem(RELOADED_KEY) === latest) return;
    sessionStorage.setItem(RELOADED_KEY, latest);
  } catch {
    // Without sessionStorage there is no loop guard: skip the reload rather than risk one.
    return;
  }
  (await registration)?.update().catch(() => {});
  location.reload();
}

// Local development serves the source files, which have no build id.
if (BUILD !== 'dev') {
  setTimeout(checkForRelease, 3000);
  setInterval(checkForRelease, CHECK_EVERY);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForRelease();
  });
}
