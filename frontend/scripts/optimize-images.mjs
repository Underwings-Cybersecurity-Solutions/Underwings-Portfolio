import sharp from 'sharp';
import { readdir, stat, readFile, writeFile } from 'fs/promises';
import { join, extname, basename } from 'path';
import { fileURLToPath } from 'url';

const IMAGES_DIR = fileURLToPath(new URL('../public/images', import.meta.url));

async function getFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function optimizeImages() {
  const files = await getFiles(IMAGES_DIR);
  let totalSaved = 0;

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const name = basename(file);
    const webpPath = file.replace(/\.(png|jpg|jpeg)$/i, '.webp');

    // Skip already-optimized files
    if (ext === '.webp' || ext === '.svg' || ext === '.ico') continue;

    // Skip tiny files (< 5KB)
    const s = await stat(file);
    if (s.size < 5000) continue;

    // Check if WebP already exists
    try {
      await stat(webpPath);
      console.log(`  SKIP ${name} (WebP exists)`);
      continue;
    } catch {}

    try {
      const original = s.size;
      const buffer = await sharp(file)
        .webp({ quality: 80 })
        .toBuffer();

      if (buffer.length < original) {
        await writeFile(webpPath, buffer);
        const saved = original - buffer.length;
        totalSaved += saved;
        console.log(`  DONE ${name} → WebP (${(original/1024).toFixed(0)}KB → ${(buffer.length/1024).toFixed(0)}KB, saved ${(saved/1024).toFixed(0)}KB)`);
      } else {
        console.log(`  SKIP ${name} (WebP not smaller)`);
      }
    } catch (err) {
      console.log(`  FAIL ${name}: ${err.message}`);
    }
  }

  console.log(`\nTotal saved: ${(totalSaved/1024).toFixed(0)}KB`);
}

optimizeImages();
