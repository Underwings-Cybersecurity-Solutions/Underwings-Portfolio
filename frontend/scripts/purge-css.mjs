import { PurgeCSS } from 'purgecss';
import { readdir, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

const CSS_DIR = fileURLToPath(new URL('../public/css', import.meta.url));
const DIST_DIR = fileURLToPath(new URL('../dist/client', import.meta.url));

async function getHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getHtmlFiles(full));
    } else if (entry.name.endsWith('.html')) {
      files.push(full);
    }
  }
  return files;
}

async function purge() {
  const htmlFiles = await getHtmlFiles(DIST_DIR);
  console.log(`Found ${htmlFiles.length} HTML files to scan\n`);

  const cssFiles = ['webflow.css', 'underwings-org.webflow.css'];

  for (const cssFile of cssFiles) {
    const cssPath = join(CSS_DIR, cssFile);
    const originalStat = await stat(cssPath);
    const originalSize = originalStat.size;

    const result = await new PurgeCSS().purge({
      content: htmlFiles.map(f => ({ raw: '', extension: 'html' })).length ? htmlFiles : [],
      css: [cssPath],
      safelist: {
        standard: [
          /^w-/,
          /^is-/,
          /^has-/,
          /^active/,
          /^open/,
          /^show/,
          /^hide/,
          /modal/,
          /dropdown/,
          /collapse/,
          /navbar/,
          /nav-/,
          /menu/,
          /slider/,
          /lightbox/,
          /tab/,
          /hover/,
          /focus/,
          /current/,
          'body',
          'html',
        ],
        greedy: [
          /data-wf/,
          /w-variant/,
          /w-nav/,
          /w-form/,
          /w-slider/,
          /w-tab/,
        ]
      },
      dynamicAttributes: ['data-wf-page', 'data-wf-site', 'data-w-id'],
    });

    if (result[0]) {
      const purgedSize = Buffer.byteLength(result[0].css, 'utf8');
      const saved = originalSize - purgedSize;
      const pct = ((saved / originalSize) * 100).toFixed(1);

      console.log(`${cssFile}:`);
      console.log(`  Original: ${(originalSize / 1024).toFixed(1)}KB`);
      console.log(`  Purged:   ${(purgedSize / 1024).toFixed(1)}KB`);
      console.log(`  Saved:    ${(saved / 1024).toFixed(1)}KB (${pct}%)\n`);

      // Write purged version
      await writeFile(cssPath, result[0].css);
    }
  }
}

purge();
