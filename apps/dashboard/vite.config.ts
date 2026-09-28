import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000', '/v': 'http://localhost:4000', '/s': 'http://localhost:4000' } },
});
