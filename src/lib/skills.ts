import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PROJECT_CWD } from "../config.js";
import { tool, type StoreTool } from "./tool.js";

const SKILLS_DIR = join(PROJECT_CWD, ".claude", "skills");

export interface Skill {
  name: string;
  description: string;
  body: string;
}

function parse(name: string, raw: string): Skill {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const front = m?.[1] ?? "";
  const body = m ? raw.slice(m[0].length).trim() : raw.trim();
  const desc = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
  return { name, description: desc, body };
}

/** Read .claude/skills/<name>/SKILL.md once at startup. */
function load(): Skill[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(SKILLS_DIR, d.name, "SKILL.md"))
    .filter(existsSync)
    .map((p) => parse(p.split("/").at(-2)!, readFileSync(p, "utf8")));
}

export const SKILLS: Skill[] = load();

/** The index that goes in the system prompt — names + descriptions only. */
export function skillIndex(): string {
  if (SKILLS.length === 0) return "- (none)";
  return SKILLS.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

/**
 * Progressive disclosure: the model sees the one-line index above and pulls the
 * full playbook only for the skill the current turn actually needs.
 */
export const readSkillTool: StoreTool = tool(
  "read_skill",
  `Read the full playbook for one of the store's skills before doing that kind of work. Available: ${SKILLS.map((s) => s.name).join(", ")}.`,
  { name: z.string().describe("Skill name, e.g. 'billing'") },
  async ({ name }) => {
    const s = SKILLS.find((x) => x.name === name.trim().toLowerCase());
    if (!s)
      return {
        content: [{ type: "text", text: `No skill "${name}". Available: ${SKILLS.map((x) => x.name).join(", ")}.` }],
        isError: true,
      };
    return { content: [{ type: "text", text: s.body }], structuredContent: { skill: s.name } };
  }
);
