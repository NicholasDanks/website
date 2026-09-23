/**
 * Relay for the SEMinR review assistant on the site's own Gemini key.
 *
 * The browser posts a streamGenerateContent body here; this function adds the
 * key (server-side env var GEMINI_SITE_KEY, never sent to the browser) and
 * streams Google's SSE response straight back. Visitors who paste their own key
 * bypass this and call Google directly from the browser.
 *
 * What it guards against: extraction of the key from the page (the key is no
 * longer in any bundle), use of the relay from other websites (same-origin check),
 * arbitrary models (allowlist), oversized requests, and bursts (Netlify rate
 * limit per IP). What it cannot stop: a determined script that forges the
 * Origin header and stays under the rate limit. The free tier's own quota, on a
 * project with no billing, is the backstop.
 *
 * It logs nothing about the request content.
 */
import { EVALUATOR_MODELS } from "../../src/lib/seminr/evaluator";

const MODELS = new Set(EVALUATOR_MODELS.map((m) => m.id));
const MAX_BODY_BYTES = 2_000_000;

const env = (name: string): string => (process.env[name] ?? "").trim();

const SITE_ORIGINS = new Set(["https://nicholasdanks.com", "https://www.nicholasdanks.com"]);

/**
 * Same-origin rule: the page calling the relay must be served from the host the
 * relay runs on (production, or this site's own deploy previews). Netlify does
 * not expose URL / DEPLOY_PRIME_URL to functions at runtime, so the request's own
 * origin is the reference.
 */
function originOk(origin: string, requestUrl: string): boolean {
  if (!origin) return false;
  if (SITE_ORIGINS.has(origin)) return true;
  let self = "";
  try { self = new URL(requestUrl).origin; } catch { /* ignore */ }
  if (origin === self && (self.endsWith(".netlify.app") || SITE_ORIGINS.has(self))) return true;
  // Local `netlify dev` only.
  return env("NETLIFY_DEV") === "true" && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

/** Errors in Google's own shape, so the page's existing error handling reads them. */
function fail(code: number, status: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, status, message } }), {
    status: code,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async (req: Request, context: { params?: Record<string, string> }): Promise<Response> => {
  if (req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "Use POST.");

  const key = env("GEMINI_SITE_KEY");
  if (!key) return fail(503, "UNAVAILABLE", "The site's shared review is not configured. Paste your own Gemini key instead.");

  if (!originOk(req.headers.get("origin") ?? "", req.url)) return fail(403, "PERMISSION_DENIED", "This relay only serves nicholasdanks.com.");

  const model = context.params?.model ?? new URL(req.url).pathname.split("/").pop() ?? "";
  if (!MODELS.has(model)) return fail(400, "INVALID_ARGUMENT", "Unknown model.");

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return fail(413, "INVALID_ARGUMENT", "Request too large.");
  const body = await req.text();
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return fail(413, "INVALID_ARGUMENT", "Request too large.");
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.contents)) return fail(400, "INVALID_ARGUMENT", "Missing contents.");
  } catch {
    return fail(400, "INVALID_ARGUMENT", "Body is not JSON.");
  }

  const upstreamBase = env("GEMINI_UPSTREAM") || "https://generativelanguage.googleapis.com";
  let upstream: Response;
  try {
    upstream = await fetch(`${upstreamBase}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body,
      signal: req.signal,
    });
  } catch {
    return fail(502, "UNAVAILABLE", "Could not reach Google.");
  }

  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
    "Cache-Control": "no-store",
  });
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return new Response(upstream.body, { status: upstream.status, headers });
};

export const config = {
  path: "/api/gemini/:model",
  method: ["POST"],
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
