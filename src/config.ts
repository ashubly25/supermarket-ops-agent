import { resolve } from "node:path";

// Routed through the Vercel AI Gateway, so the id is "<provider>/<model>".
export const MODEL = process.env.MODEL ?? "anthropic/claude-sonnet-5";
export const ARTIFACTS_DIR = resolve(process.env.ARTIFACTS_DIR ?? "./artifacts");
export const PROJECT_CWD = resolve(".");

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}
