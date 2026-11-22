// Subsets the bundled Material Symbols font to just the icons the app
// actually uses, and stores the result as base64 text (the repo's GitHub
// push path only accepts UTF-8 files, so the font lives as .b64 — see
// scripts/decode-font.cjs).
//
// Run manually whenever an icon is added or removed:
//   node scripts/subset-font.cjs
//
// How it works (three stages — each one exists because of a fontTools
// quirk, documented where it bites):
//  - Scans src/ for every <span class="material-symbols-outlined">…</span>
//    (direct text and string literals inside the span, e.g. ternaries and
//    the innerHTML delete button), so dynamic icons like
//    'add_photo_alternate' are caught too — a plain text search misses
//    those.
//  - Stage 1: pyftsubset --text=<names> with --layout-features=rlig
//    (the icon ligatures live under `rlig`, not `liga` — passing only
//    liga,kern silently drops the whole GSUB table and every icon renders
//    as its raw word). This keeps all 22 ligatures but also ~3772 others.
//  - Stage 2: scripts/filter-font-ligatures.py drops every ligature
//    except the 22 wanted ones. pyftsubset prunes ligatures by first
//    glyph only, and the first glyphs are just letters shared by
//    thousands of icon names, so without this stage the next pass keeps
//    ~3500 icon glyphs.
//  - Stage 3: pyftsubset --glyphs=<exact set from font-glyphs.py> drops
//    every glyph the 22 ligatures no longer reference (glyph names are
//    read from the font itself: file_upload's ligature produces 'upload',
//    and '.fill' variants exist for only some icons).
//  - scripts/check-font-subset.py then verifies the result keeps the
//    FILL/wght variable axes and a ligature for every icon — a subset
//    that lost them would render every icon at the default weight/fill,
//    or as the raw word.
//  - Writes the subset to material-symbols-outlined.woff2 (the file
//    index.css references) and to
//    material-symbols-outlined.subset.woff2.b64 (the checked-in source
//    decode-font.cjs prefers). The full font's .b64 stays as the source of
//    truth for future re-subsets; `npm run build` itself stays node-only
//    (no python needed) because it only decodes the checked-in subset.
//  - Writes the icon list to scripts/material-symbols-icons.txt; the
//    build-time check in decode-font.cjs fails the build if src uses an
//    icon that is not in that list, so a missing icon can never ship
//    silently as blank space (or as the raw word, e.g. "settings").
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const FONT_DIR = path.join(SRC, 'assets', 'fonts');
const FULL_B64 = path.join(FONT_DIR, 'material-symbols-outlined.woff2.b64');
const FULL_WOFF2 = path.join(FONT_DIR, 'material-symbols-outlined.full.woff2');
const SUBSET_WOFF2 = path.join(FONT_DIR, 'material-symbols-outlined.woff2');
const SUBSET_B64 = path.join(FONT_DIR, 'material-symbols-outlined.subset.woff2.b64');
const ICONS_TXT = path.join(__dirname, 'material-symbols-icons.txt');

// Every icon name used anywhere in src: the text inside each icon span,
// including string literals in ternaries / innerHTML within the span.
function scanIcons() {
  const names = new Set();
  const scanFile = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    const spanRe = /material-symbols-outlined[\s\S]{0,600}?<\/span>/g;
    let m;
    while ((m = spanRe.exec(text))) {
      const inner = m[0];
      for (const t of inner.matchAll(/>\s*([a-z_]+)\s*</g)) names.add(t[1]);
      for (const t of inner.matchAll(/'([a-z_]+)'/g)) names.add(t[1]);
    }
  };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsx|js|css)$/.test(e.name)) scanFile(p);
    }
  };
  walk(SRC);
  return [...names].sort();
}

function main() {
  const icons = scanIcons();
  if (icons.length === 0) {
    console.error('subset-font: no icons found in src — refusing to subset to nothing');
    process.exit(1);
  }
  console.log(`subset-font: ${icons.length} icons: ${icons.join(', ')}`);
  fs.writeFileSync(ICONS_TXT, `${icons.join('\n')}\n`);

  if (!fs.existsSync(FULL_WOFF2)) {
    if (!fs.existsSync(FULL_B64)) {
      console.error('subset-font: full font source missing:', FULL_B64);
      process.exit(1);
    }
    fs.writeFileSync(FULL_WOFF2, Buffer.from(fs.readFileSync(FULL_B64, 'utf8').trim(), 'base64'));
  }
  const fullSize = fs.statSync(FULL_WOFF2).size;
  const tmpWide = path.join(FONT_DIR, '.subset.wide.woff2');
  const tmpFiltered = path.join(FONT_DIR, '.subset.filtered.woff2');
  const tmpOut = path.join(FONT_DIR, '.subset.tmp.woff2');
  const cleanup = () => {
    for (const f of [tmpWide, tmpFiltered, tmpOut]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  };
  try {
    // Stage 1: --text keeps the 22 ligatures (and ~3772 others).
    execFileSync('python3', [
      '-m', 'fontTools.subset', FULL_WOFF2,
      `--output-file=${tmpWide}`,
      `--text=${icons.join(' ')}`,
      '--layout-features=rlig,liga,kern',
      '--flavor=woff2',
    ], { stdio: 'inherit' });

    // Stage 2: drop every ligature except the 22 wanted ones.
    execFileSync('python3', [
      path.join(__dirname, 'filter-font-ligatures.py'), tmpWide, tmpFiltered, ICONS_TXT,
    ], { stdio: 'inherit' });

    // Stage 3: drop every glyph the 22 ligatures no longer reference.
    // The glyph set is read from the FILTERED font (stage 1 renames the
    // icon glyphs, so the full font's names no longer match).
    const glyphs = execFileSync('python3', [
      path.join(__dirname, 'font-glyphs.py'), tmpFiltered, ICONS_TXT,
    ], { encoding: 'utf8' }).trim();
    execFileSync('python3', [
      '-m', 'fontTools.subset', tmpFiltered,
      `--output-file=${tmpOut}`,
      `--glyphs=${glyphs}`,
      '--layout-features=rlig,liga,kern',
      '--flavor=woff2',
    ], { stdio: 'inherit' });

    // Verify: FILL/wght axes kept, one ligature per icon.
    execFileSync('python3', [
      path.join(__dirname, 'check-font-subset.py'), tmpOut, ICONS_TXT,
    ], { stdio: 'inherit' });
  } catch {
    cleanup();
    process.exit(1);
  }

  const subset = fs.readFileSync(tmpOut);
  cleanup();
  fs.writeFileSync(SUBSET_WOFF2, subset);
  fs.writeFileSync(SUBSET_B64, subset.toString('base64'));
  console.log(`subset-font: ${fullSize} bytes -> ${subset.length} bytes (${(100 * subset.length / fullSize).toFixed(1)}% of full)`);
  console.log(`subset-font: wrote ${SUBSET_WOFF2} and ${SUBSET_B64}`);
}

if (require.main === module) main();

module.exports = { scanIcons, ICONS_TXT };
