/**
 * OpenRouter Chat Completions provider (single provider for this experiment).
 * OpenAI-compatible HTTP API via fetch. Key from OPENROUTER_API_KEY (.env or env).
 */

import { loadRepoEnv } from "./load-env.ts";
import type {
  ChatMessage,
  ChatModel,
  ChatToolCall,
  ChatToolDefinition,
  ModelTurn,
  TokenUsage,
} from "./types.ts";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
/** Keep completions small so low OpenRouter balances can still run the experiment. */
const DEFAULT_MAX_TOKENS = 512;

/** Generation settings actually sent (or deliberately left unset) for this experiment. */
export interface OpenRouterGenerationSettings {
  provider: "openrouter";
  model: string;
  /** Explicitly unset — provider default applies; not a numeric zero. */
  temperature: "unset";
  /** Explicitly unset — not configured for this experiment. */
  seed: "unset";
  max_tokens: number;
  tool_choice: "auto";
}

export function requireOpenRouterApiKey(): string {
  loadRepoEnv();
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Paste it into the repo-root .env file (OPENROUTER_API_KEY=...) before the live agent experiment.",
    );
  }
  return key;
}

export function resolveOpenRouterModel(options?: { model?: string }): string {
  loadRepoEnv();
  return options?.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
}

export function resolveOpenRouterMaxTokens(): number {
  loadRepoEnv();
  return Number(process.env.OPENROUTER_MAX_TOKENS) || DEFAULT_MAX_TOKENS;
}

export function getOpenRouterGenerationSettings(options?: {
  model?: string;
}): OpenRouterGenerationSettings {
  return {
    provider: "openrouter",
    model: resolveOpenRouterModel(options),
    temperature: "unset",
    seed: "unset",
    max_tokens: resolveOpenRouterMaxTokens(),
    tool_choice: "auto",
  };
}

export function createOpenRouterChatModel(options?: {
  apiKey?: string;
  model?: string;
}): ChatModel {
  const apiKey = options?.apiKey ?? requireOpenRouterApiKey();
  const model = resolveOpenRouterModel(options);
  const maxTokens = resolveOpenRouterMaxTokens();

  return {
    model,
    async complete(input): Promise<ModelTurn> {
      // Temperature and seed intentionally omitted so sampling matches prior experiment.
      const body = {
        model,
        messages: input.messages.map(toChatMessage),
        tools: input.tools.map(toChatTool),
        tool_choice: "auto" as const,
        max_tokens: maxTokens,
      };

      const response = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `OpenRouter chat completion failed (${response.status}): ${detail.slice(0, 500)}`,
        );
      }

      const payload = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          cost?: number;
          total_cost?: number;
        };
      };

      const message = payload.choices?.[0]?.message;
      if (!message) {
        throw new Error("OpenRouter response missing choices[0].message");
      }

      const toolCalls: ChatToolCall[] = (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        argumentsJson: call.function.arguments,
      }));

      const usage = parseUsage(payload.usage);
      return {
        content: message.content ?? null,
        toolCalls,
        ...(usage ? { usage } : {}),
      };
    },
  };
}

function parseUsage(
  raw:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cost?: number;
        total_cost?: number;
      }
    | undefined,
): TokenUsage | undefined {
  if (!raw) return undefined;
  const prompt = raw.prompt_tokens;
  const completion = raw.completion_tokens;
  const total = raw.total_tokens;
  if (
    typeof prompt !== "number" ||
    typeof completion !== "number" ||
    typeof total !== "number"
  ) {
    return undefined;
  }
  const usage: TokenUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
  const cost =
    typeof raw.cost === "number"
      ? raw.cost
      : typeof raw.total_cost === "number"
        ? raw.total_cost
        : undefined;
  if (cost !== undefined) {
    usage.cost = cost;
  }
  return usage;
}

function toChatTool(tool: ChatToolDefinition): unknown {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toChatMessage(message: ChatMessage): unknown {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.tool_call_id,
      content: message.content ?? "",
    };
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.argumentsJson,
        },
      })),
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
}
