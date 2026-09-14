/**
 * Anthropic transport for test/model-compare.mjs only (the site itself calls
 * Gemini; see src/lib/seminr/evaluator.ts). Same system prompt, same
 * run_model tool and same opening message, so Claude models can be compared
 * with Gemini on identical inputs. Needs ANTHROPIC_API_KEY.
 */
import Anthropic from "@anthropic-ai/sdk";
import { RUN_MODEL_TOOL, SYSTEM_PROMPT } from "../src/lib/seminr/evaluator.ts";

/** List prices, USD per 1M tokens: input, cache write, cache read, output. */
export const ANTHROPIC_MODELS = {
  "claude-opus-5": { price: { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }, shape: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } },
  "claude-sonnet-5": { price: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }, shape: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } },
  "claude-haiku-4-5": { price: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }, shape: { thinking: { type: "enabled", budget_tokens: 8000 } } },
};

export function anthropicCost(usage, modelId) {
  const p = ANTHROPIC_MODELS[modelId]?.price;
  if (!p) return null;
  return (usage.input * p.input + usage.cacheWrite * p.cacheWrite + usage.cacheRead * p.cacheRead + usage.output * p.output) / 1e6;
}

const limit = (text, max = 60_000) => (text.length > max ? text.slice(0, max) + "\n…[truncated]" : text);

export async function runAnthropicTurn({ model, apiKey, baseURL, opening, runModel, events, systemPrompt = SYSTEM_PROMPT }) {
  const spec = ANTHROPIC_MODELS[model];
  if (!spec) throw new Error(`unknown Anthropic model ${model}`);
  // A key not scoped to a workspace must name one: ANTHROPIC_WORKSPACE_ID=wrkspc_…
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}), ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}) });
  const tool = { name: RUN_MODEL_TOOL.name, description: RUN_MODEL_TOOL.description, strict: true, input_schema: RUN_MODEL_TOOL.input_schema };
  const messages = [{ role: "user", content: opening }];
  let useFallbacks = true;
  let toolRuns = 0;
  const MAX_TOOL_RUNS = 8;
  for (let iteration = 0; iteration < 12; iteration++) {
    const base = {
      model, max_tokens: 16000,
      cache_control: { type: "ephemeral" },
      ...spec.shape,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools: [tool], messages,
    };
    let message;
    try {
      const stream = useFallbacks
        ? client.beta.messages.stream({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : client.messages.stream(base);
      stream.on("text", (delta) => events.onText(delta));
      message = await stream.finalMessage();
    } catch (err) {
      if (useFallbacks && err instanceof Anthropic.BadRequestError) { useFallbacks = false; iteration--; continue; }
      throw err;
    }
    events.onUsage({ input: message.usage.input_tokens, output: message.usage.output_tokens, cacheRead: message.usage.cache_read_input_tokens ?? 0, cacheWrite: message.usage.cache_creation_input_tokens ?? 0 });
    messages.push({ role: "assistant", content: message.content });
    if (message.stop_reason === "refusal") { events.onText("\n\n[The assistant declined to continue this request.]"); return; }
    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason !== "tool_use") return;
    const results = [];
    for (const call of message.content.filter((b) => b.type === "tool_use")) {
      const input = call.input;
      if (++toolRuns > MAX_TOOL_RUNS) { results.push({ type: "tool_result", tool_use_id: call.id, content: `Run limit reached (${MAX_TOOL_RUNS} per message). Summarise what you have.`, is_error: true }); continue; }
      events.onToolStart({ id: call.id, input });
      try {
        const digest = await runModel(input);
        const gates = digest.assessment.filter((a) => a.kind === "gate");
        const summary = `${digest.constructs.length} constructs, ${digest.paths.length} paths, ${gates.filter((a) => a.status === "fail").length} problems, ${gates.filter((a) => a.status === "warn").length} to check`;
        events.onToolEnd({ id: call.id, input, ok: true, summary });
        results.push({ type: "tool_result", tool_use_id: call.id, content: limit(JSON.stringify(digest)) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        events.onToolEnd({ id: call.id, input, ok: false, summary: msg });
        results.push({ type: "tool_result", tool_use_id: call.id, content: `The run failed: ${msg}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
}
