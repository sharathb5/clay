/** Structured final classification from the agent. */
export type Classification =
  | "strong_fit"
  | "medium_fit"
  | "weak_fit"
  | "unclear";

export interface ClassificationResult {
  company: string;
  classification: Classification;
  rationale: string;
  evidence_used: string[];
  missing_evidence: string[];
}

export type AgentVersion = "v1" | "v2";

/** One observed tool invocation (Clay tools only). */
export interface ObservedToolCall {
  toolName: string;
  arguments: unknown;
}

export interface AgentRunResult {
  agentVersion: AgentVersion;
  mode: "record" | "strict_replay";
  final: ClassificationResult;
  toolSequence: ObservedToolCall[];
  /** Model/provider label used for this run (no secrets). */
  model: string;
}

export interface ChatToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelTurn {
  content: string | null;
  toolCalls: ChatToolCall[];
}

/** Minimal LLM boundary for this experiment (OpenAI only). */
export interface ChatModel {
  readonly model: string;
  complete(input: {
    messages: ChatMessage[];
    tools: ChatToolDefinition[];
  }): Promise<ModelTurn>;
}
