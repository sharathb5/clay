/**
 * Minimal tool-using agent runner.
 * Clay tools go only through the interceptor; finish_classification is local.
 */

import type { Interceptor } from "../../src/interceptor.ts";
import { systemPromptFor, USER_TASK } from "./policies.ts";
import { parseClassificationResult } from "./schema.ts";
import { AGENT_TOOLS, FINISH_TOOL_NAME, isClayToolName } from "./tools.ts";
import type {
  AgentRunResult,
  AgentVersion,
  ChatMessage,
  ChatModel,
  ObservedToolCall,
} from "./types.ts";

const DEFAULT_MAX_TURNS = 8;

export interface RunAgentOptions {
  version: AgentVersion;
  mode: "record" | "strict_replay";
  model: ChatModel;
  interceptor: Interceptor;
  maxTurns?: number;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPromptFor(options.version) },
    { role: "user", content: USER_TASK },
  ];
  const toolSequence: ObservedToolCall[] = [];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const modelTurn = await options.model.complete({
      messages,
      tools: AGENT_TOOLS,
    });

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
        content: JSON.stringify(response),
      });
    }
  }

  throw new Error(
    `Agent ${options.version} exceeded max turns (${maxTurns}) without finish_classification`,
  );
}
