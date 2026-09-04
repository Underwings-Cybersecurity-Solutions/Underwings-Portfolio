// Minify all JS and CSS files in public/ in place.
// Run after purge-css.mjs so CSS is both purged and minified.
import { transform } from 'esbuild';
import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

function isMinified(path) {
  return /\.min\.(js|css)$/i.test(path);
}

async function minifyFile(path) {
  const ext = extname(path).toLowerCase();
  if (ext !== '.js' && ext !== '.css') return null;
  if (isMinified(path)) return null;

  const src = await readFile(path, 'utf8');
  const before = Buffer.byteLength(src, 'utf8');

  const loader = ext === '.js' ? 'js' : 'css';
  const result = await transform(src, {
    loader,
    minify: true,
    legalComments: 'none',
    target: ['es2019'],
  });

  await writeFile(path, result.code);
  const after = Buffer.byteLength(result.code, 'utf8');
  return { path, before, after };
}

async function main() {
  const files = await walk(PUBLIC_DIR);
  const targets = files.filter(f => /\.(js|css)$/i.test(f) && !isMinified(f));
  let totalBefore = 0, totalAfter = 0, count = 0, failed = 0;

  for (const f of targets) {
    try {
      const r = await minifyFile(f);
      if (!r) continue;
      totalBefore += r.before;
      totalAfter += r.after;
      count++;
      const pct = ((1 - r.after / r.before) * 100).toFixed(1);
      console.log(`  ${r.path.replace(PUBLIC_DIR, 'public')}  ${(r.before / 1024).toFixed(1)}KB → ${(r.after / 1024).toFixed(1)}KB  (-${pct}%)`);
    } catch (err) {
      failed++;
      console.warn(`  SKIP ${f.replace(PUBLIC_DIR, 'public')}: ${err.message}`);
    }
  }

  const saved = totalBefore - totalAfter;
  const pct = totalBefore ? ((saved / totalBefore) * 100).toFixed(1) : '0';
  console.log(`\nMinified ${count} files · ${(totalBefore / 1024).toFixed(1)}KB → ${(totalAfter / 1024).toFixed(1)}KB · saved ${(saved / 1024).toFixed(1)}KB (${pct}%)${failed ? ` · ${failed} skipped` : ''}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
