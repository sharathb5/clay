import { CLASSIFICATION_JSON_SCHEMA } from "./schema.ts";
import type { ChatToolDefinition } from "./types.ts";

/** Clay tools allowed through the interceptor for this experiment. */
export const CLAY_TOOL_NAMES = [
  "find-and-enrich-company",
  "get-task-context",
] as const;

export type ClayToolName = (typeof CLAY_TOOL_NAMES)[number];

/** Runner-local finalization tool (never sent to Clay / interceptor). */
export const FINISH_TOOL_NAME = "finish_classification";

export const AGENT_TOOLS: ChatToolDefinition[] = [
  {
    name: "find-and-enrich-company",
    description:
      "Find publicly available company info by domain. For this experiment, pass only companyIdentifier. Do not request companyDataPoints.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["companyIdentifier"],
      properties: {
        companyIdentifier: {
          type: "string",
          description: 'Company domain, e.g. "notion.so"',
        },
      },
    },
  },
  {
    name: "get-task-context",
    description:
      "Retrieve entities and enrichment values for a prior Clay search task. Pass the taskId from find-and-enrich-company.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: {
        taskId: {
          type: "string",
          description: "Task ID returned by find-and-enrich-company",
        },
      },
    },
  },
  {
    name: FINISH_TOOL_NAME,
    description:
      "Submit the final structured ICP classification. Call once when ready.",
    parameters: CLASSIFICATION_JSON_SCHEMA as unknown as Record<string, unknown>,
  },
];

export function isClayToolName(name: string): name is ClayToolName {
  return (CLAY_TOOL_NAMES as readonly string[]).includes(name);
}
