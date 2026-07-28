import { resolve } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

const MODEL_ID = process.env.MODEL ?? "anthropic/claude-sonnet-5";

/**
 * Which key is set decides how we reach the model. A direct key wins when both are.
 * Everything downstream just takes a LanguageModel.
 *
 *  - ANTHROPIC_API_KEY  → Anthropic directly (own rate limits and billing).
 *  - AI_GATEWAY_API_KEY → a bare "<provider>/<model>" string, which the AI SDK routes
 *    through the Vercel AI Gateway. Note the gateway's 401 is worded as if the env var
 *    were missing; it says the same thing for an expired or revoked key.
 */
export const MODEL: LanguageModel = process.env.ANTHROPIC_API_KEY
  ? createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(MODEL_ID.replace(/^anthropic\//, ""))
  : MODEL_ID;

export const MODEL_LABEL = process.env.ANTHROPIC_API_KEY
  ? `${MODEL_ID.replace(/^anthropic\//, "")} (Anthropic direct)`
  : `${MODEL_ID} (AI Gateway)`;
export const ARTIFACTS_DIR = resolve(process.env.ARTIFACTS_DIR ?? "./artifacts");
export const PROJECT_CWD = resolve(".");

/** Fail at boot rather than on the owner's first message. */
export function requireModelKey(): void {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.AI_GATEWAY_API_KEY)
    throw new Error("Set ANTHROPIC_API_KEY (direct) or AI_GATEWAY_API_KEY (Vercel AI Gateway) in .env.");
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}
