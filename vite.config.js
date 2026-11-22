import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite plugin: strip `crossorigin` attributes from built HTML.
 * Electron loads pages via file:// where crossorigin triggers CORS
 * checks that always fail, preventing scripts and styles from loading.
 */
function stripCrossOrigin() {
  return {
    name: 'strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, '');
    },
  };
}

/**
 * Vite plugin: drop the legacy `.woff` Inter files from the bundle.
 * @fontsource's CSS references both woff2 and woff for every weight;
 * Chromium (and Electron) always picks woff2, so the 8 `.woff` files
 * (~310 KB) are dead weight. This removes them from the emitted bundle
 * and strips their `url(...) format('woff')` entries from the CSS, so
 * no dangling references ship. (Round-2 improvement 5.)
 */
function dropWoff() {
  return {
    name: 'drop-woff',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith('.woff')) {
          delete bundle[fileName];
        } else if (fileName.endsWith('.css') && chunk.type === 'asset') {
          // Minified CSS has no spaces and double quotes:
          // url(./x.woff2)format("woff2"),url(./x.woff)format("woff")
          chunk.source = chunk.source
            .replace(/,\s*url\([^)]*\.woff\)\s*format\(["']woff["']\)/g, '');
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stripCrossOrigin(), dropWoff()],
  base: './',
  build: {
    assetsInlineLimit: 4096,
  },
  server: {
    watch: {
      ignored: ['**/.electron-userdata/**']
    }
  }
});
