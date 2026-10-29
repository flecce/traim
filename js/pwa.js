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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
