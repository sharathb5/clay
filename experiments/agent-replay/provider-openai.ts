/**
 * OpenAI Chat Completions provider (single provider for this experiment).
 * Uses fetch — no SDK dependency. API key is read from OPENAI_API_KEY only.
 */

import type {
  ChatMessage,
  ChatModel,
  ChatToolCall,
  ChatToolDefinition,
  ModelTurn,
} from "./types.ts";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

export function requireOpenAiApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error(
      "OPENAI_API_KEY is not set. Provider blocker: export OPENAI_API_KEY before the live agent experiment.",
    );
  }
  return key;
}

export function createOpenAiChatModel(options?: {
  apiKey?: string;
  model?: string;
}): ChatModel {
  const apiKey = options?.apiKey ?? requireOpenAiApiKey();
  const model = options?.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

  return {
    model,
    async complete(input): Promise<ModelTurn> {
      const body = {
        model,
        messages: input.messages.map(toOpenAiMessage),
        tools: input.tools.map(toOpenAiTool),
        tool_choice: "auto" as const,
      };

      const response = await fetch(OPENAI_CHAT_URL, {
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
          `OpenAI chat completion failed (${response.status}): ${detail.slice(0, 500)}`,
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
        throw new Error("OpenAI response missing choices[0].message");
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

function toOpenAiTool(tool: ChatToolDefinition): unknown {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toOpenAiMessage(message: ChatMessage): unknown {
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
