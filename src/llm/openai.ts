import { config } from '../config.js';

const RATE_LIMIT_DELAY_MS = 100;
const MAX_RETRIES = 3;

let lastCallTime = 0;

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAICallResult {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call OpenAI's chat completions API with rate limiting and retries.
 */
export async function callOpenAI(
  prompt: string,
  systemPrompt: string,
  retryCount = 0
): Promise<OpenAICallResult> {
  // Simple rate limiting
  const now = Date.now();
  const timeSinceLastCall = now - lastCallTime;
  if (timeSinceLastCall < RATE_LIMIT_DELAY_MS) {
    await sleep(RATE_LIMIT_DELAY_MS - timeSinceLastCall);
  }
  lastCallTime = Date.now();

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, // Low temperature for consistent matching
      max_tokens: 300,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();

    // Rate limited - exponential backoff
    if (response.status === 429 && retryCount < MAX_RETRIES) {
      const backoffMs = Math.pow(2, retryCount) * 1000;
      console.log(`OpenAI rate limited, retrying in ${backoffMs}ms...`);
      await sleep(backoffMs);
      return callOpenAI(prompt, systemPrompt, retryCount + 1);
    }

    // Server errors - retry once
    if ((response.status >= 500 && response.status < 600) && retryCount < 1) {
      console.log(`OpenAI server error ${response.status}, retrying in 2s...`);
      await sleep(2000);
      return callOpenAI(prompt, systemPrompt, retryCount + 1);
    }

    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  const data = await response.json() as ChatCompletionResponse;
  const content = data.choices[0]?.message?.content || '';

  return {
    content,
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
  };
}
