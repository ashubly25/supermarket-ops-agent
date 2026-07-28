/**
 * Telegram messages are sent with no parse_mode, so any markdown the model emits reaches
 * the owner's phone literally: `**50 kg**` shows the asterisks, and a pipe table renders as
 * a wall of `|---|---|`. The system prompt forbids both, but a prompt is a request, not a
 * guarantee — so we normalise here, where the text actually leaves the process.
 *
 * Deliberately conservative: this reformats presentation, never numbers or wording.
 */

/** `| Item | Qty |` + `|---|---|` + rows → one readable line per row. */
function flattenTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const isDivider = (line: string) => /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(line) && line.includes("-");

  while (i < lines.length) {
    const isRow = (l?: string) => l !== undefined && l.trim().startsWith("|") && l.includes("|", 1);
    // A table is a header row, a --- divider, then body rows.
    if (isRow(lines[i]) && isDivider(lines[i + 1] ?? "")) {
      const headers = cells(lines[i]);
      i += 2;
      while (i < lines.length && isRow(lines[i])) {
        const row = cells(lines[i]);
        // First cell leads; the rest become "label value" pairs, skipping empties.
        const rest = row
          .slice(1)
          .map((v, idx) => ({ h: headers[idx + 1] ?? "", v }))
          .filter(({ v }) => v !== "" && v !== "-")
          .map(({ h, v }) => (h ? `${h.toLowerCase()} ${v}` : v));
        out.push(rest.length ? `• ${row[0]} — ${rest.join(", ")}` : `• ${row[0]}`);
        i += 1;
      }
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join("\n");
}

/** Strip the inline markers Telegram won't render. */
function stripMarkers(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, "") // fenced code blocks
    .replace(/(\*\*|__)(.+?)\1/gs, "$2") // bold
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, "$1") // italics, not bullet "* "
    .replace(/(?<![\w`])`([^`\n]+)`(?![\w`])/g, "$1") // inline code
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-*]\s+/gm, "• ") // list bullets → a real bullet
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)"); // links
}

/** Make model output safe for a parse_mode-less Telegram message. */
export function toPlainText(text: string): string {
  return stripMarkers(flattenTables(text))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
