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

/** Token usage reported by the provider for one or more completions. */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Present only when the provider returns an explicit cost field. */
  cost?: number;
}

export interface AgentRunResult {
  agentVersion: AgentVersion;
  mode: "record" | "strict_replay";
  final: ClassificationResult;
  toolSequence: ObservedToolCall[];
  /** Model/provider label used for this run (no secrets). */
  model: string;
  /** Aggregated provider usage across turns in this run, when available. */
  usage?: TokenUsage;
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
  /** Provider-reported usage for this completion, when available. */
  usage?: TokenUsage;
}

/** Minimal LLM boundary for this experiment (OpenRouter only). */
export interface ChatModel {
  readonly model: string;
  complete(input: {
    messages: ChatMessage[];
    tools: ChatToolDefinition[];
  }): Promise<ModelTurn>;
}
