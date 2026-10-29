// Builds the published site: JS and CSS get a content hash in their file name (app.3f9a1c2b.js),
// so every release is fetched fresh and unchanged files stay cached. index.html keeps its name
// but carries the build id, which the app compares with version.json to reload open pages.
// Usage: node tools/build.mjs [outDir=_site]
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = resolve(root, process.argv[2] ?? '_site');
// Icons keep their names: they are also referenced from strings inside the app code.
const STATIC = ['icons'];

const read = (path) => readFileSync(join(root, path), 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 8);
const withHash = (path, h) => path.replace(/\.(\w+)$/, `.${h}.$1`);

function listFiles(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );
}

// Original path -> hashed path, e.g. "js/app.js" -> "js/app.3f9a1c2b.js".
const renamed = new Map();
const contents = new Map();
const visiting = new Set();

// Relative module specifiers: from './x.js', import './x.js', import('./x.js').
const IMPORT = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;

// A module's hash covers its imports' hashed names, so a change deep in the graph renames every importer.
function buildModule(path) {
  if (renamed.has(path)) return renamed.get(path);
  if (visiting.has(path)) throw new Error(`Import cycle through ${path}`);
  visiting.add(path);
  const source = read(path).replace(IMPORT, (_, lead, quote, spec) => {
    const target = posix.join(posix.dirname(path), spec);
    const hashed = buildModule(target);
    const rel = posix.relative(posix.dirname(path), hashed);
    return `${lead}${quote}${rel.startsWith('.') ? rel : `./${rel}`}${quote}`;
  });
  visiting.delete(path);
  const hashed = withHash(path, hash(source));
  renamed.set(path, hashed);
  contents.set(hashed, source);
  return hashed;
}

for (const file of listFiles('js')) buildModule(file);
for (const file of listFiles('css')) {
  const source = read(file);
  const hashed = withHash(file, hash(source));
  renamed.set(file, hashed);
  contents.set(hashed, source);
}

const build = hash([...renamed.values()].sort().join('\n') + read('index.html') + read('sw.js') + read('manifest.webmanifest'));

// Replaces quoted original paths ("js/app.js", 'css/style.css') with their hashed names.
function rewritePaths(text) {
  let result = text;
  for (const [from, to] of renamed) result = result.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`);
  return result;
}

const index = rewritePaths(read('index.html')).replace(
  /<meta name="traim-build" content="[^"]*">/,
  `<meta name="traim-build" content="${build}">`,
);
if (!index.includes(build)) throw new Error('index.html has no <meta name="traim-build"> tag');

// The service worker caches the hashed shell under a cache named after the build.
const shell = ['./', 'index.html', 'manifest.webmanifest', ...STATIC.flatMap(listFiles), ...renamed.values()];
const sw = read('sw.js')
  .replace(/const BUILD = '[^']*';/, `const BUILD = '${build}';`)
  .replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = ${JSON.stringify(shell, null, 2)};`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [path, text] of contents) {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  writeFileSync(join(out, path), text);
}
for (const dir of STATIC) cpSync(join(root, dir), join(out, dir), { recursive: true });
writeFileSync(join(out, 'index.html'), index);
writeFileSync(join(out, 'sw.js'), sw);
writeFileSync(join(out, 'manifest.webmanifest'), read('manifest.webmanifest'));
writeFileSync(join(out, 'version.json'), JSON.stringify({ build }));
writeFileSync(join(out, '.nojekyll'), '');

console.log(`build ${build}: ${renamed.size} hashed files in ${relative(root, out) || '.'}`);
