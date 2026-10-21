import {
  analysisResultSchema,
  type AnalysisInput,
  type AnalysisResult,
  buildAnalysisMessages,
} from "./prompt.js";

export interface AiClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutSec?: number;
  temperature?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AnalysisResponse {
  result: AnalysisResult;
  usage: ChatUsage;
  latencyMs: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleClient {
  private readonly baseUrl: string;

  constructor(private readonly options: AiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.options.apiKey)
      headers.authorization = `Bearer ${this.options.apiKey}`;
    return headers;
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout((this.options.timeoutSec ?? 60) * 1000),
    });
    if (!response.ok) {
      throw new Error(`model list failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => Boolean(id));
  }

  async analyze(input: AnalysisInput): Promise<AnalysisResponse> {
    const started = performance.now();
    const messages = buildAnalysisMessages(input);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.options.model,
        messages,
        temperature: this.options.temperature ?? 0.2,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout((this.options.timeoutSec ?? 60) * 1000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `analysis failed: HTTP ${response.status} ${detail.slice(0, 300)}`,
      );
    }

    const body = (await response.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("analysis failed: empty response");

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      throw new Error("analysis failed: model did not return valid JSON");
    }

    const result = analysisResultSchema.parse(parsedJson);
    return {
      result,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
      latencyMs: performance.now() - started,
    };
  }
}

export { analysisResultSchema };
export type { AnalysisInput, AnalysisResult };
