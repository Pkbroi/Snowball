/**
 * verify-dist — packaging guard for `npm run electron:build`.
 *
 * electron-builder does NOT run the Vite build itself, so running it with
 * a deleted/stale dist/ silently packaged an exe with no app files in it
 * (v2: the window opened to a black screen because dist/index.html did
 * not exist inside the asar). This script runs after `vite build` and
 * fails the build loudly if the renderer output is missing.
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const indexHtml = path.join(dist, 'index.html');
const assets = path.join(dist, 'assets');

const missing = [];
if (!fs.existsSync(indexHtml)) missing.push('dist/index.html');
if (!fs.existsSync(assets) || fs.readdirSync(assets).filter((f) => f.endsWith('.js')).length === 0) {
  missing.push('dist/assets/*.js');
}
if (missing.length > 0) {
  console.error(`verify-dist FAILED: missing ${missing.join(', ')} — did the Vite build run?`);
  process.exit(1);
}
console.log(`verify-dist OK: ${indexHtml} + ${fs.readdirSync(assets).length} asset(s) present`);
