import type { StreamFn } from "@mariozechner/pi-agent-core";
import { wrapWithToolCalling } from "../tool-calling/web-stream-middleware.js";

const WEB_STREAM_API_IDS = [
  "deepseek-web",
  "claude-web",
  "doubao-web",
  "chatgpt-web",
  "qwen-web",
  "qwen-cn-web",
  "kimi-web",
  "gemini-web",
  "grok-web",
  "glm-web",
  "glm-intl-web",
  "perplexity-web",
  "xiaomimo-web",
] as const;

export type WebStreamApiId = (typeof WEB_STREAM_API_IDS)[number];

async function loadStreamFactory(
  api: WebStreamApiId,
): Promise<(cookie: string) => StreamFn> {
  switch (api) {
    case "deepseek-web": {
      const mod = await import("./deepseek-web-stream.js");
      return mod.createDeepseekWebStreamFn;
    }
    case "claude-web": {
      const mod = await import("./claude-web-stream-http.js");
      return mod.createClaudeWebStreamFn;
    }
    case "doubao-web": {
      const mod = await import("./doubao-web-stream.js");
      return mod.createDoubaoWebStreamFn;
    }
    case "chatgpt-web": {
      const mod = await import("./chatgpt-web-stream.js");
      return mod.createChatGPTWebStreamFn;
    }
    case "qwen-web": {
      const mod = await import("./qwen-web-stream.js");
      return mod.createQwenWebStreamFn;
    }
    case "qwen-cn-web": {
      const mod = await import("./qwen-cn-web-stream.js");
      return mod.createQwenCNWebStreamFn;
    }
    case "kimi-web": {
      const mod = await import("./kimi-web-stream.js");
      return mod.createKimiWebStreamFn;
    }
    case "gemini-web": {
      const mod = await import("./gemini-web-stream.js");
      return mod.createGeminiWebStreamFn;
    }
    case "grok-web": {
      const mod = await import("./grok-web-stream.js");
      return mod.createGrokWebStreamFn;
    }
    case "glm-web": {
      const mod = await import("./glm-web-stream.js");
      return mod.createGlmWebStreamFn;
    }
    case "glm-intl-web": {
      const mod = await import("./glm-intl-web-stream.js");
      return mod.createGlmIntlWebStreamFn;
    }
    case "perplexity-web": {
      const mod = await import("./perplexity-web-stream.js");
      return mod.createPerplexityWebStreamFn;
    }
    case "xiaomimo-web": {
      const mod = await import("./xiaomimo-web-stream.js");
      return mod.createXiaomiMimoWebStreamFn;
    }
  }
}

export function getWebStreamFactory(
  api: string,
): ((cookie: string) => StreamFn) | undefined {
  if (!(WEB_STREAM_API_IDS as readonly string[]).includes(api)) {
    return undefined;
  }
  const apiId = api as WebStreamApiId;

  return (cookie: string) => {
    // Lazily load and create the stream function on first call.
    // Returns a StreamFn that wraps the real provider's stream with tool calling.
    const lazyPromise = loadStreamFactory(apiId).then((factory) =>
      wrapWithToolCalling(factory(cookie), api),
    );

    // Return a proxy StreamFn that delegates to the lazily loaded one.
    const proxy = ((model: Parameters<StreamFn>[0], context: Parameters<StreamFn>[1], opts: Parameters<StreamFn>[2]) => {
      const innerPromise = lazyPromise.then((inner) => inner(model, context, opts));
      // Return a Promise<EventStream> compatible with StreamFn return type
      return innerPromise;
    }) as StreamFn;

    return proxy;
  };
}

export function listWebStreamApiIds(): WebStreamApiId[] {
  return [...WEB_STREAM_API_IDS];
}
