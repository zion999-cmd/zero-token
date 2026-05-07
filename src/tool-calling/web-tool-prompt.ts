/**
 * Per-model tool calling prompt templates.
 *
 * Reference:
 * - Paper: https://arxiv.org/html/2407.04997v1
 * - ComfyUI LLM Party: https://github.com/heshengtao/comfyui_LLM_party
 */

import { toolDefsJson } from "./web-tool-defs.js";

const TOOL_DEFS = toolDefsJson();

// Example-based teaching (key insight from arXiv:2407.04997 and ComfyUI LLM Party):
// A trivial example teaches the model the output format without confusing it with real tools.
const TOOL_EXAMPLE = `Example: to add 1 to number 5, return:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one is just an example, not a real tool)`;

const EN_TEMPLATE = `Tools: ${TOOL_DEFS}

${TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block.
No tool needed? Answer directly.

`;

const EN_STRICT_TEMPLATE = `Tools: ${TOOL_DEFS}

${TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block. No extra text.
No tool needed? Answer directly.

`;

const CN_TEMPLATE = `工具: ${TOOL_DEFS}

示例: 要给数字5加1，返回:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one仅为示例，非真实工具)

你的真实工具见上方列表。需要时只回复tool_json块。不需要则直接回答。

`;

/** No web models skip prompt injection — web interfaces don't pass native tools.
 *  Even DeepSeek/Claude/GLM need prompt injection when accessed via browser. */
const NATIVE_TOOL_MODELS = new Set<string>();

/** Models excluded from tool calling entirely */
const EXCLUDED_MODELS = new Set(["perplexity-web", "doubao-web"]);

/** Chinese-language models */
const CN_MODELS = new Set([
  "deepseek-web",
  "doubao-web",
  "qwen-cn-web",
  "kimi-web",
  "glm-web",
  "xiaomimo-web",
]);

/** Models that tend to add extra text after JSON */
const STRICT_MODELS = new Set(["chatgpt-web"]);

export function shouldInjectToolPrompt(api: string): boolean {
  return !NATIVE_TOOL_MODELS.has(api) && !EXCLUDED_MODELS.has(api);
}

export function getToolPrompt(api: string): string {
  if (STRICT_MODELS.has(api)) {
    return EN_STRICT_TEMPLATE;
  }
  if (CN_MODELS.has(api)) {
    return CN_TEMPLATE;
  }
  return EN_TEMPLATE;
}

// ── Provider-specific user tool prompt generators ────────

export interface UserToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

type PromptStrategy = "tool_json" | "react" | "function_call";

const STRATEGY: Record<string, PromptStrategy> = {
  "deepseek-web": "tool_json",
  "kimi-web": "tool_json",
  "glm-web": "tool_json",
  "glm-intl-web": "tool_json",
  "qwen-web": "react",
  "qwen-cn-web": "react",
  "grok-web": "function_call",
  "doubao-web": "tool_json",
  "chatgpt-web": "function_call",
  "claude-web": "function_call",
  "gemini-web": "tool_json",
  "perplexity-web": "tool_json",
  "xiaomimo-web": "tool_json",
};

function getStrategy(api: string): PromptStrategy {
  return STRATEGY[api] || "tool_json";
}

/**
 * Build a tool call example that uses the ACTUAL tool name and parameter names,
 * but uses "value" as a placeholder for parameter values.
 */
function buildExample(tools: UserToolDef[]): string {
  const t = tools[0];
  if (!t) return "";
  const params = (t.parameters?.properties || {}) as Record<string, { type?: string; description?: string }>;
  const args = Object.entries(params).map(([k]) => `"${k}":"value"`).join(", ");
  return `<tool_call name="${t.name}">{${args}}</tool_call>`;
}

function buildReactExample(tools: UserToolDef[]): string {
  const t = tools[0];
  if (!t) return "";
  const params = (t.parameters?.properties || {}) as Record<string, { type?: string; description?: string }>;
  const args = Object.entries(params).map(([k]) => `${k}="value"`).join(", ");
  return `Thought: I need to use ${t.name}\nAction: ${t.name}\nAction Input: ${args}`;
}

function buildFunctionExample(tools: UserToolDef[]): string {
  const t = tools[0];
  if (!t) return "";
  const params = (t.parameters?.properties || {}) as Record<string, unknown>;
  const args = Object.keys(params).map(k => `"${k}":"value"`).join(", ");
  return `{"name":"${t.name}","arguments":{${args}}}`;
}

export function getUserToolPrompt(api: string, tools: UserToolDef[]): string {
  if (tools.length === 0) return "";
  const strategy = getStrategy(api);

  switch (strategy) {
    case "react": {
      let p = "## Tools\n";
      for (const t of tools) {
        const params = (t.parameters?.properties || {}) as Record<string, { type?: string; description?: string }>;
        const paramStr = Object.entries(params).map(([k,v]) => `  - ${k} (${v.type || "string"}): ${v.description || ""}`).join("\n");
        p += `- ${t.name}: ${t.description}\n${paramStr}\n`;
      }
      p += `\nWhen you need a tool, respond ONLY with:\nThought: reasoning\nAction: tool_name\nAction Input: arg1="val1", arg2="val2"\n\n`;
      p += `Example:\n${buildReactExample(tools)}\n`;
      return p;
    }

    case "function_call": {
      let p = "## Functions\n";
      for (const t of tools) {
        p += `${JSON.stringify({name: t.name, description: t.description, parameters: t.parameters}, null, 2)}\n`;
      }
      p += `\nCall a function by outputting ONLY:\n${buildFunctionExample(tools)}\n`;
      return p;
    }

    case "tool_json":
    default: {
      let p = "## Tools\n";
      for (const t of tools) {
        const params = (t.parameters?.properties || {}) as Record<string, unknown>;
        const required = (t.parameters?.required || []) as string[];
        const paramList = Object.entries(params).map(([k]) => {
          const req = required.includes(k) ? " (required)" : "";
          return `${k}${req}`;
        }).join(", ");
        p += `- ${t.name}(${paramList}): ${t.description || ""}\n`;
      }
      p += `\nCall a tool by outputting ONLY:\n${buildExample(tools)}\n`;
      return p;
    }
  }
}

/** Format tool result for feedback to the model */
export function formatToolResult(toolName: string, result: string): string {
  return `Tool ${toolName} returned: ${result}\nPlease continue answering based on this result.`;
}
