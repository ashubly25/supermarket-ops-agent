import { resolve } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

const MODEL_ID = process.env.MODEL ?? "anthropic/claude-sonnet-5";

/**
 * Which key is set decides how we reach the model — three routes, checked in order of
 * directness. Everything downstream just takes a LanguageModel.
 *
 *  - ANTHROPIC_API_KEY   → Anthropic directly (own rate limits and billing).
 *  - OPENROUTER_API_KEY  → OpenRouter. Also matched when AI_GATEWAY_API_KEY holds an
 *    `sk-or-` key, because that mistake is silent and expensive: the AI SDK would hand
 *    an OpenRouter key to the Vercel AI Gateway, which answers 401 worded as if the env
 *    var were missing at all.
 *  - AI_GATEWAY_API_KEY  → a bare "<provider>/<model>" string, which the AI SDK routes
 *    through the Vercel AI Gateway.
 *
 * Model IDs are "<provider>/<model>" everywhere, which is also OpenRouter's own format,
 * so switching route is an env-var change and never a code change.
 */
const openRouterKey =
  process.env.OPENROUTER_API_KEY ??
  (process.env.AI_GATEWAY_API_KEY?.startsWith("sk-or-") ? process.env.AI_GATEWAY_API_KEY : undefined);

export const MODEL: LanguageModel = process.env.ANTHROPIC_API_KEY
  ? createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(MODEL_ID.replace(/^anthropic\//, ""))
  : openRouterKey
    ? createOpenRouter({ apiKey: openRouterKey }).chat(MODEL_ID)
    : MODEL_ID;

export const MODEL_LABEL = process.env.ANTHROPIC_API_KEY
  ? `${MODEL_ID.replace(/^anthropic\//, "")} (Anthropic direct)`
  : openRouterKey
    ? `${MODEL_ID} (OpenRouter)`
    : `${MODEL_ID} (Vercel AI Gateway)`;

export const ARTIFACTS_DIR = resolve(process.env.ARTIFACTS_DIR ?? "./artifacts");
export const PROJECT_CWD = resolve(".");

/** Fail at boot rather than on the owner's first message. */
export function requireModelKey(): void {
  if (!process.env.ANTHROPIC_API_KEY && !openRouterKey && !process.env.AI_GATEWAY_API_KEY)
    throw new Error(
      "Set one of ANTHROPIC_API_KEY (direct), OPENROUTER_API_KEY, or AI_GATEWAY_API_KEY (Vercel AI Gateway) in .env."
    );
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}
