// Decodes the bundled Material Symbols font (stored as base64 text in the
// repo because the GitHub push path only accepts UTF-8 files) into the
// .woff2 that index.css references. Runs before `vite build` (prebuild)
// and before `vite` (dev), and is a no-op when the font already exists.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'src', 'assets', 'fonts');
const woff2 = path.join(dir, 'material-symbols-outlined.woff2');
const b64 = path.join(dir, 'material-symbols-outlined.woff2.b64');

if (!fs.existsSync(woff2)) {
  if (!fs.existsSync(b64)) {
    console.error('decode-font: base64 font source missing:', b64);
    process.exit(1);
  }
  fs.writeFileSync(woff2, Buffer.from(fs.readFileSync(b64, 'utf8').trim(), 'base64'));
  console.log('decode-font: wrote', woff2);
}
