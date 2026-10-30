/**
 * OpenAI 兼容 /chat/completions 客户端（会话摘要用，设计文档 docs/llm-summary.md §4）。
 * 与 core/embeddings.ts 同一模式：批量不需要、单次调用 + 429/网络指数退避；
 * 查询侧（resume/search 定向生成）用短超时、不重试；回填侧用长超时、可重试。
 */

/** 输出上限：200 汉字 / 500 字符（prompt 里声明，存储前再硬截断兜底）。 */
export const SUMMARY_MAX_CHARS = 500;

export interface ChatConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  /** baseUrl 主机（指纹组成部分：换主机旧摘要失效） */
  host: string;
}

export class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 429 / 5xx / 网络错误 → 指数退避重试；其它（400/响应结构不符）直接抛出。 */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ChatRequestError";
  }
}

export interface ChatProvider {
  readonly model: string;
  /** 单轮对话：system + user 两条消息，返回正文。 */
  complete(system: string, user: string): Promise<string>;
}

function chatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function parseChatBody(body: string, label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ChatRequestError(`${label}接口返回的不是 JSON——请检查${label}的接口配置是否为 OpenAI 兼容接口。`, 0, false);
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    const message = (parsed as { error?: { message?: string } }).error?.message;
    throw new ChatRequestError(
      `${label}接口响应缺少 choices${message ? `：${message}` : ""}——请检查配置的模型是否为对话模型。`,
      0,
      false,
    );
  }
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new ChatRequestError(`${label}接口返回了空内容。`, 0, false);
  }
  return content.trim();
}

export interface ChatProviderOptions {
  config: ChatConfig;
  /** 错误信息里的功能名（默认「摘要」）。 */
  label?: string;
  /** 单次请求超时；回填默认 60s，定向生成传 6s。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export function createChatProvider(opts: ChatProviderOptions): ChatProvider {
  const { config } = opts;
  const label = opts.label ?? "摘要";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxRetries = opts.maxRetries ?? 3;
  const url = chatUrl(config.baseUrl);

  async function callOnce(system: string, user: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.2,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ChatRequestError(`${label}接口请求失败（${message}）`, 0, true);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const snippet = body.replace(/\s+/g, " ").slice(0, 200);
      throw new ChatRequestError(
        `${label}接口返回 HTTP ${res.status}${snippet ? `：${snippet}` : ""}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
    return parseChatBody(await res.text(), label);
  }

  return {
    model: config.model,
    async complete(system: string, user: string): Promise<string> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callOnce(system, user);
        } catch (err) {
          if (!(err instanceof ChatRequestError) || !err.retryable || attempt >= maxRetries) throw err;
          await sleep(1000 * 2 ** attempt);
        }
      }
    },
  };
}
