import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as schedules from "../repo/schedules.js";
import { runJob } from "../jobs.js";

export interface Ctx {
  chatId: string;
}

function ok(text: string, data?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(data !== undefined ? { structuredContent: data as Record<string, unknown> } : {}),
  };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

const KINDS = ["weekly_deck", "khata_reminder", "daily_close"] as const;

export function makeScheduleTools(ctx: Ctx) {
  const setSchedule = tool(
    "set_schedule",
    "Set up a recurring push the bot sends on its own: weekly_deck (PPTX analysis of the last 7 days), khata_reminder (digest of customers who owe money), or daily_close (end-of-day summary). Use for 'send me the analysis deck every Monday morning', 'remind me about udhaar every week'. Setting the same kind again updates it.",
    {
      kind: z.enum(KINDS),
      weekday: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe("0=Sunday … 6=Saturday. Omit for every day (use for daily_close)."),
      hour: z.number().int().min(0).max(23).default(9).describe("Server-local hour"),
      minute: z.number().int().min(0).max(59).default(0),
    },
    async (a) => {
      const s = schedules.upsert({
        chat_id: ctx.chatId,
        kind: a.kind,
        weekday: a.weekday ?? null,
        hour: a.hour,
        minute: a.minute,
        enabled: 1,
      });
      return ok(`Scheduled: ${schedules.describe(s)}. I'll send it automatically — no need to ask.`, { schedule: s });
    }
  );

  const listSchedules = tool(
    "list_schedules",
    "Show the owner's active scheduled pushes (weekly deck, khata reminders, daily close).",
    {},
    async () => {
      const rows = schedules.list(ctx.chatId);
      if (rows.length === 0) return ok("Nothing scheduled yet.", { schedules: [] });
      return ok(rows.map((s) => `• ${schedules.describe(s)}${s.last_run ? ` — last sent ${s.last_run}` : ""}`).join("\n"), {
        schedules: rows,
      });
    }
  );

  const cancelSchedule = tool(
    "cancel_schedule",
    "Stop a recurring push the owner previously set up.",
    { kind: z.enum(KINDS) },
    async ({ kind }) => {
      if (!schedules.remove(ctx.chatId, kind)) return err(`No ${kind} schedule was set.`);
      return ok(`Cancelled the ${kind} schedule.`, { kind });
    }
  );

  const runNow = tool(
    "run_scheduled_job_now",
    "Run one of the scheduled jobs immediately (a dry run of what the schedule would send). Useful when the owner asks 'show me what the weekly deck looks like'.",
    { kind: z.enum(KINDS) },
    async ({ kind }) => {
      try {
        const r = await runJob({
          id: -1, chat_id: ctx.chatId, kind, weekday: null, hour: 0, minute: 0, enabled: 1, last_run: null,
        });
        return ok(`Ran ${kind} now — ${r.summary}. Sending it to you.`, r);
      } catch (e) {
        return err(`Job failed: ${(e as Error).message}`);
      }
    }
  );

  return [setSchedule, listSchedules, cancelSchedule, runNow];
}
