/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** The /seminr/ review assistant's site-owned Gemini key (free tier, referrer-restricted); optional. */
  readonly PUBLIC_GEMINI_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
