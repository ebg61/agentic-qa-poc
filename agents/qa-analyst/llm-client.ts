/**
 * Isolated LLM port.
 *
 * The QA analysis logic does not depend on a specific provider.
 * This implementation uses the OpenAI Responses API.
 */

export interface LlmClient {
  completeJson(systemPrompt: string, userPrompt: string): Promise<string>;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5-mini";

export function createLlmClient(): LlmClient {
  return {
    completeJson: completeOpenAiCompatibleJson,
  };
}

async function completeOpenAiCompatibleJson(
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const apiKey = process.env.LLM_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "LLM_API_KEY is missing. Set it in the environment before running the QA Analyst."
    );
  }

  const baseUrl = (process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = process.env.LLM_MODEL ?? DEFAULT_MODEL;

  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      input: `${userPrompt}\n\nReturn the result as JSON.`,
      text: {
        format: {
          type: "json_object",
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `LLM request failed (${response.status} ${response.statusText}): ${body}`
    );
  }

  const data: unknown = await response.json();

  return readResponseText(data);
}

function readResponseText(data: unknown): string {
  if (typeof data !== "object" || data === null) {
    throw new Error("LLM returned a malformed response");
  }

  const response = data as {
    output?: unknown;
  };

  if (!Array.isArray(response.output)) {
    throw new Error("LLM returned no output items");
  }

  for (const item of response.output) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const content = (item as { content?: unknown }).content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (typeof part !== "object" || part === null) {
        continue;
      }

      const type = (part as { type?: unknown }).type;
      const text = (part as { text?: unknown }).text;

      if (
        type === "output_text" &&
        typeof text === "string" &&
        text.trim()
      ) {
        return text;
      }
    }
  }

  throw new Error("LLM returned an empty response");
}