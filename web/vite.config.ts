import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    // Static output, deployable to Netlify, Vercel, GitHub Pages or anywhere else.
    outDir: 'dist',
    sourcemap: false,
    // The ElevenLabs SDK is a large vendor bundle we do not control: it carries
    // a WebRTC stack. It is reached through a dynamic import, so it lands in its
    // own chunk and never blocks the first paint. Raising the warning limit
    // stops the build from complaining about something already handled.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
  },
});
