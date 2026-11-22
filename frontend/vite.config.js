import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [],
  server: {port: 5173, strictPort: true, proxy: {'/api': 'http://127.0.0.1:8787'}},
  build: {outDir: 'dist', emptyOutDir: true, sourcemap: false}
});
