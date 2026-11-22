import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig(({mode}) => ({
  plugins: [],
  resolve: {
    alias: {
      '#simulator': fileURLToPath(new URL(
        mode === 'vercel' ? './src/browser-simulator.js' : './src/http-simulator.js',
        import.meta.url
      ))
    }
  },
  server: {port: 5173, strictPort: true, proxy: {'/api': 'http://127.0.0.1:8787'}},
  build: {outDir: 'dist', emptyOutDir: true, sourcemap: false}
}));
