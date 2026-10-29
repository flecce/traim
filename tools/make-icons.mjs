// Draws the app icon (a white train front on teal) and writes icons/icon-<size>.png.
// Usage: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { join } from 'node:path';

const BG = [0x0e, 0x6b, 0x5c];
const FG = [0xff, 0xff, 0xff];

const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && dx * dx + dy * dy <= r * r;
};
const circle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const segment = (x, y, ax, ay, bx, by, w) => {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return (x - ax - t * (bx - ax)) ** 2 + (y - ay - t * (by - ay)) ** 2 <= (w / 2) ** 2;
};

// Shape kept inside the central 80% so it survives maskable cropping. Coordinates are 0..1.
function isForeground(x, y) {
  const body = roundRect(x, y, 0.3, 0.22, 0.7, 0.66, 0.09);
  const windshield = roundRect(x, y, 0.36, 0.3, 0.64, 0.45, 0.03);
  const lights = circle(x, y, 0.39, 0.565, 0.035) || circle(x, y, 0.61, 0.565, 0.035);
  const rails = segment(x, y, 0.41, 0.7, 0.33, 0.8, 0.035) || segment(x, y, 0.59, 0.7, 0.67, 0.8, 0.035);
  return (body && !windshield && !lights) || rails;
}

function png(size) {
  const ss = 4;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) if (isForeground((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size)) hits++;
      const a = hits / (ss * ss);
      const o = py * (size * 3 + 1) + 1 + px * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = join(import.meta.dirname, '..', 'icons');
mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) writeFileSync(join(dir, `icon-${size}.png`), png(size));
console.log('icons written to', dir);
