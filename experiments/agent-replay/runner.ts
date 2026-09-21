/**
 * Minimal tool-using agent runner.
 * Clay tools go only through the interceptor; finish_classification is local.
 */

import type { Interceptor } from "../../src/interceptor.ts";
import { COMPANY_DOMAIN, systemPromptFor, USER_TASK } from "./policies.ts";
import { parseClassificationResult } from "./schema.ts";
import { AGENT_TOOLS, FINISH_TOOL_NAME, isClayToolName } from "./tools.ts";
import type {
  AgentRunResult,
  AgentVersion,
  ChatMessage,
  ChatModel,
  ObservedToolCall,
  TokenUsage,
} from "./types.ts";

const DEFAULT_MAX_TURNS = 8;
/** Cap tool payloads returned to the model; full responses remain in the trace. */
const MODEL_TOOL_RESULT_CHARS = 2_500;

export interface RunAgentOptions {
  version: AgentVersion;
  mode: "record" | "strict_replay";
  model: ChatModel;
  interceptor: Interceptor;
  maxTurns?: number;
  /**
   * Company domain under evaluation. Substitutes into the existing V1/V2 prompts
   * without changing ICP wording or decision-policy bullets.
   */
  companyDomain?: string;
}

function truncateForModel(value: unknown): string {
  const raw = JSON.stringify(value);
  if (raw.length <= MODEL_TOOL_RESULT_CHARS) {
    return raw;
  }
  return `${raw.slice(0, MODEL_TOOL_RESULT_CHARS)}…[truncated for model context; full result is in the replay trace]`;
}

function promptsForDomain(version: AgentVersion, domain: string): {
  system: string;
  user: string;
} {
  // Domain-only substitution; ICP and decision-policy text stay intact.
  if (domain === COMPANY_DOMAIN) {
    return {
      system: systemPromptFor(version),
      user: USER_TASK,
    };
  }
  return {
    system: systemPromptFor(version).split(COMPANY_DOMAIN).join(domain),
    user: USER_TASK.split(COMPANY_DOMAIN).join(domain),
  };
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const domain = options.companyDomain ?? COMPANY_DOMAIN;
  const prompts = promptsForDomain(options.version, domain);
  const messages: ChatMessage[] = [
    { role: "system", content: prompts.system },
    { role: "user", content: prompts.user },
  ];
  const toolSequence: ObservedToolCall[] = [];
  let usage: TokenUsage | undefined;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    // Fresh conversation state is local to this runAgent invocation.
    const modelTurn = await options.model.complete({
      messages,
      tools: AGENT_TOOLS,
    });
    usage = accumulateUsage(usage, modelTurn.usage);

    if (modelTurn.toolCalls.length === 0) {
      throw new Error(
        `Agent ${options.version} ended a turn without tool calls; expected tools or finish_classification`,
      );
    }

    messages.push({
      role: "assistant",
      content: modelTurn.content,
      tool_calls: modelTurn.toolCalls,
    });

    for (const call of modelTurn.toolCalls) {
      let args: unknown;
      try {
        args = JSON.parse(call.argumentsJson || "{}");
      } catch {
        throw new Error(
          `Agent ${options.version} produced invalid JSON arguments for ${call.name}`,
        );
      }

      if (call.name === FINISH_TOOL_NAME) {
        const final = parseClassificationResult(args);
        return {
          agentVersion: options.version,
          mode: options.mode,
          final,
          toolSequence,
          model: options.model.model,
          ...(usage ? { usage } : {}),
        };
      }

      if (!isClayToolName(call.name)) {
        throw new Error(
          `Agent ${options.version} called unknown tool ${call.name}`,
        );
      }

      // Sole Clay boundary: interceptor only.
      const response = await options.interceptor.call(call.name, args);
      toolSequence.push({ toolName: call.name, arguments: args });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: truncateForModel(response),
      });
    }
  }

  throw new Error(
    `Agent ${options.version} exceeded max turns (${maxTurns}) without finish_classification`,
  );
}

function accumulateUsage(
  current: TokenUsage | undefined,
  next: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!next) return current;
  if (!current) return { ...next };
  const merged: TokenUsage = {
    prompt_tokens: current.prompt_tokens + next.prompt_tokens,
    completion_tokens: current.completion_tokens + next.completion_tokens,
    total_tokens: current.total_tokens + next.total_tokens,
  };
  if (current.cost !== undefined || next.cost !== undefined) {
    merged.cost = (current.cost ?? 0) + (next.cost ?? 0);
  }
  return merged;
}
