// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://nicholasdanks.com',
  integrations: [sitemap()],
  // The congruence test now lives inside the full SEMinR app.
  redirects: { '/congruence': '/seminr/' },
  vite: {
    plugins: [tailwindcss()],
    // The seminr worker is started with { type: 'module' }, so build it as
    // one too — otherwise Vite emits it as an IIFE.
    worker: { format: 'es' },
    // Never inline component scripts: the Content-Security-Policy allows no
    // inline JavaScript, so every <script> must ship as a file.
    build: { assetsInlineLimit: 0 },
  },
});
