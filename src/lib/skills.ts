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

/**
 * The index that goes in the system prompt — descriptions plus the NAMES of the tools each
 * skill unlocks.
 *
 * The names matter as much as the descriptions. With schemas withheld until a skill is read,
 * a model that cannot see `generate_invoice_pdf` may conclude the capability doesn't exist
 * and simply claim the work is done — observed exactly once here, a fabricated "PDF is on its
 * way" with an empty outbox. Listing the names costs a few tokens per skill and removes the
 * ambiguity: the capability is real, and reading the skill is how you reach it.
 */
export function skillIndex(toolNames: Record<string, string[]> = {}): string {
  if (SKILLS.length === 0) return "- (none)";
  return SKILLS.map((s) => {
    const names = toolNames[s.name];
    const unlocks = names?.length ? `\n  unlocks: ${names.join(", ")}` : "";
    return `- ${s.name}: ${s.description}${unlocks}`;
  }).join("\n");
}

/**
 * Progressive disclosure: the model sees the one-line index above and pulls the
 * full playbook only for the skill the current turn actually needs.
 */
export const readSkillTool: StoreTool = tool(
  "read_skill",
  `Open one or more skills: returns their playbooks AND unlocks their tools, which are not available until you do. Call this first for the domains this turn needs — if a tool you expect is missing, this is why. Name several at once ("billing, documents") when the job spans them; that costs one round trip instead of two. Available: ${SKILLS.map((s) => s.name).join(", ")}.`,
  {
    name: z
      .string()
      .describe("Skill name, or several comma-separated when the turn needs them all, e.g. 'billing, documents'"),
  },
  async ({ name }) => {
    const wanted = name
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    const found = wanted.map((n) => SKILLS.find((x) => x.name === n)).filter((s): s is Skill => !!s);
    const missing = wanted.filter((n) => !SKILLS.some((x) => x.name === n));

    if (found.length === 0)
      return {
        content: [{ type: "text", text: `No skill "${name}". Available: ${SKILLS.map((x) => x.name).join(", ")}.` }],
        isError: true,
      };

    const note = missing.length ? `\n\n(No such skill: ${missing.join(", ")}.)` : "";
    return {
      content: [{ type: "text", text: found.map((s) => `## SKILL: ${s.name}\n\n${s.body}`).join("\n\n---\n\n") + note }],
      structuredContent: { skills: found.map((s) => s.name) },
    };
  }
);
