import { MakeMcpError } from "../errors.js";
import { ExtractionResultSchema, parseModelJson, renderTask, type ExtractionPlan, type ExtractionResult } from "./prose-api.js";

/**
 * Minimal LLM client for the CLI when no coding agent is involved. In agent mode the agent's own
 * model does the extraction and this module is not used. Bring your own key or a local model:
 *
 *   ANTHROPIC_API_KEY                         → Anthropic Messages API
 *   OPENAI_API_KEY / MAKE_MCP_LLM_BASE_URL    → any OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio, vLLM …)
 *   MAKE_MCP_LLM=anthropic|openai             → force a provider, MAKE_MCP_LLM_MODEL → model name
 */
export interface LlmClient {
  readonly label: string;
  complete(prompt: { system: string; user: string }): Promise<string>;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
const SYSTEM = "You turn API documentation into structured JSON. You only report what the documentation states.";

type Env = Record<string, string | undefined>;

export function createLlmFromEnv(env: Env = process.env): LlmClient | undefined {
  const forced = env.MAKE_MCP_LLM?.toLowerCase();
  const model = env.MAKE_MCP_LLM_MODEL;
  if (forced === "anthropic" || (!forced && env.ANTHROPIC_API_KEY)) {
    if (!env.ANTHROPIC_API_KEY) throw new MakeMcpError("INTAKE_INCOMPLETE", "MAKE_MCP_LLM=anthropic needs ANTHROPIC_API_KEY");
    return anthropicClient(env.ANTHROPIC_API_KEY, model ?? DEFAULT_ANTHROPIC_MODEL, env.ANTHROPIC_BASE_URL);
  }
  if (forced === "openai" || (!forced && (env.OPENAI_API_KEY || env.MAKE_MCP_LLM_BASE_URL))) {
    if (!model) throw new MakeMcpError("INTAKE_INCOMPLETE", "Set MAKE_MCP_LLM_MODEL for OpenAI-compatible endpoints (e.g. the model name in Ollama)");
    return openAiCompatibleClient(env.MAKE_MCP_LLM_BASE_URL ?? "https://api.openai.com/v1", model, env.OPENAI_API_KEY);
  }
  return undefined;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  if (!res.ok) throw new MakeMcpError("FETCH_FAILED", `LLM request to ${new URL(url).host} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export function anthropicClient(apiKey: string, model: string, baseUrl = "https://api.anthropic.com"): LlmClient {
  return {
    label: `Anthropic ${model}`,
    async complete({ system, user }) {
      const data = (await postJson(
        `${baseUrl.replace(/\/$/, "")}/v1/messages`,
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        { model, max_tokens: 16_000, system, messages: [{ role: "user", content: user }] },
      )) as { content?: { type: string; text?: string }[] };
      return (data.content ?? []).map((c) => c.text ?? "").join("");
    },
  };
}

export function openAiCompatibleClient(baseUrl: string, model: string, apiKey?: string): LlmClient {
  return {
    label: `${model} via ${new URL(baseUrl).host}`,
    async complete({ system, user }) {
      const data = (await postJson(`${baseUrl.replace(/\/$/, "")}/chat/completions`, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, {
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      })) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}

export interface RunExtractionOptions {
  onTask?: (index: number, total: number) => void;
}

/** Runs every task through the model; malformed answers get one retry with the validation error. */
export async function runExtraction(plan: ExtractionPlan, llm: LlmClient, options: RunExtractionOptions = {}): Promise<ExtractionResult[]> {
  const results: ExtractionResult[] = [];
  for (const [index, task] of plan.tasks.entries()) {
    options.onTask?.(index, plan.tasks.length);
    const user = renderTask(task);
    let feedback = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await llm.complete({ system: SYSTEM, user: feedback ? `${user}\n\nYour previous answer was invalid: ${feedback}\nAnswer again with valid JSON only.` : user });
      try {
        const parsed = ExtractionResultSchema.safeParse(parseModelJson(answer));
        if (parsed.success) {
          results.push(parsed.data);
          break;
        }
        feedback = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
      } catch (err) {
        feedback = `not JSON (${(err as Error).message})`;
      }
    }
  }
  return results;
}
