import { tool as aiTool, type Tool } from "ai";
import { z, type ZodRawShape } from "zod";

/**
 * Tool result shape used by every tool module: a text block the model reads,
 * plus optional structured data for tests / callers. `isError` marks a refused
 * action (guard hit) — the text still goes back to the model so it can explain.
 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface StoreTool {
  name: string;
  def: Tool;
}

/**
 * Define a store tool. Keeps the (name, description, zod shape, handler)
 * signature the tool modules were written against and adapts it to the
 * Vercel AI SDK's `tool({ description, inputSchema, execute })`.
 */
export function tool<S extends ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>
): StoreTool {
  const def = aiTool({
    description,
    inputSchema: z.object(shape),
    async execute(args: z.infer<z.ZodObject<S>>) {
      const r = await handler(args);
      const text = r.content.map((c) => c.text).join("\n");
      // Guard failures come back as ordinary text, not thrown errors: the model
      // must relay them to the owner rather than retry blindly.
      return r.isError ? `ERROR: ${text}` : text;
    },
  });
  return { name, def };
}

/** Collect store tools into the record `generateText` expects. */
export function toolset(tools: StoreTool[]): Record<string, Tool> {
  return Object.fromEntries(tools.map((t) => [t.name, t.def]));
}
