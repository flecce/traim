export const MINUTE = 60_000;

export const titleCase = (name = '') => name.toLowerCase().replace(/(^|[\s'\-/.(])\p{L}/gu, (m) => m.toUpperCase());

const simplify = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

// Station names differ between sources ("Bolzano Sud" vs "Bolzano Sud - Fiera",
// "Merano-Maia Bassa" vs "Merano Maia Bassa"), so compare both the full name and the part before " - ".
export function sameStation(a, b) {
  const base = (s) => simplify(s.split(' - ')[0]);
  return simplify(a) === simplify(b) || base(a) === base(b);
}
