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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stripCrossOrigin()],
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
