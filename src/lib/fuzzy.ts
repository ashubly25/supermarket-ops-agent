/** Lightweight product-name matcher. No external deps. */

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(s: string): string[] {
  return norm(s).split(" ").filter(Boolean);
}

/**
 * Score how well `query` matches a product `name + size`.
 * 0..1. Rewards token overlap and substring hits; size tokens (5kg/1l) count.
 */
export function matchScore(query: string, name: string, size: string): number {
  const q = tokens(query);
  if (q.length === 0) return 0;
  const target = norm(`${name} ${size}`);
  const targetToks = tokens(`${name} ${size}`);
  let hit = 0;
  for (const t of q) {
    if (targetToks.includes(t)) hit += 1;
    else if (target.includes(t)) hit += 0.6; // partial/substring
  }
  return hit / q.length;
}
