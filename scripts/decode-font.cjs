// Decodes the bundled Material Symbols font into the .woff2 that
// index.css references. Prefers the SUBSET (material-symbols-outlined
// .subset.woff2.b64, produced by `node scripts/subset-font.cjs` from the
// 22 icons the app uses — 5.8KB instead of the full 1.1MB font); falls
// back to the full font's .b64 when no subset exists. The repo stores
// base64 text because the GitHub push path only accepts UTF-8 files.
// Runs before `vite build` (prebuild) and before `vite` (dev).
//
// Also a build-time guard: scans src for icon names (the same scanner
// subset-font.cjs uses) and fails the build if any is not in
// scripts/material-symbols-icons.txt. An icon added without re-running
// subset-font.cjs would otherwise render as its raw word (e.g.
// "settings") or as blank space — this makes that impossible to ship.
const fs = require('node:fs');
const path = require('node:path');
const { scanIcons, ICONS_TXT } = require('./subset-font.cjs');

const dir = path.join(__dirname, '..', 'src', 'assets', 'fonts');
const woff2 = path.join(dir, 'material-symbols-outlined.woff2');
const subsetB64 = path.join(dir, 'material-symbols-outlined.subset.woff2.b64');
const fullB64 = path.join(dir, 'material-symbols-outlined.woff2.b64');

// 1. Coverage check — runs on every build and dev start.
const listed = fs.existsSync(ICONS_TXT)
  ? fs.readFileSync(ICONS_TXT, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  : [];
const missing = scanIcons().filter((n) => !listed.includes(n));
if (missing.length > 0) {
  console.error(`decode-font: icons used in src but not in the subset font: ${missing.join(', ')}`);
  console.error('decode-font: run `node scripts/subset-font.cjs` to re-subset, then rebuild.');
  process.exit(1);
}

// 2. Decode the subset (preferred) or the full font, when the .woff2 is
// missing or older than its .b64 source.
const src = fs.existsSync(subsetB64) ? subsetB64 : fullB64;
if (!fs.existsSync(woff2) || fs.statSync(src).mtimeMs > fs.statSync(woff2).mtimeMs) {
  if (!fs.existsSync(src)) {
    console.error('decode-font: font source missing:', src);
    process.exit(1);
  }
  fs.writeFileSync(woff2, Buffer.from(fs.readFileSync(src, 'utf8').trim(), 'base64'));
  console.log('decode-font: wrote', woff2, 'from', path.basename(src));
}
