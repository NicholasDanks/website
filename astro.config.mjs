// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://nicholasdanks.com',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
    // The congruence worker is started with { type: 'module' }, so build it as
    // one too — otherwise Vite emits it as an IIFE. (It still emits a second,
    // unreferenced copy of the worker chunk; that file is never fetched, so it
    // costs deploy size only.)
    worker: { format: 'es' },
  },
});
