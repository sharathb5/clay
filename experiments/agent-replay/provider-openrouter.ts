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
} from "./types.ts";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
/** Keep completions small so low OpenRouter balances can still run the experiment. */
const DEFAULT_MAX_TOKENS = 512;

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

export function createOpenRouterChatModel(options?: {
  apiKey?: string;
  model?: string;
}): ChatModel {
  const apiKey = options?.apiKey ?? requireOpenRouterApiKey();
  loadRepoEnv();
  const model =
    options?.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;

  return {
    model,
    async complete(input): Promise<ModelTurn> {
      const body = {
        model,
        messages: input.messages.map(toChatMessage),
        tools: input.tools.map(toChatTool),
        tool_choice: "auto" as const,
        max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
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

      return {
        content: message.content ?? null,
        toolCalls,
      };
    },
  };
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
