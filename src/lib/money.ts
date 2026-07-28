/** Round to 2 decimal places (paise), avoiding binary float drift. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round to nearest rupee (for bill grand-total round-off, Indian retail norm). */
export function roundRupee(n: number): number {
  return Math.round(n);
}

/**
 * GST breakup for one line, given a GST-INCLUSIVE unit price (Indian MRP convention).
 * Returns taxable value (ex-GST), total tax, and CGST/SGST (intra-state → equal halves).
 */
export function gstBreakup(unitPriceInclusive: number, qty: number, gstRate: number) {
  const gross = round2(unitPriceInclusive * qty);
  const taxable = round2(gross / (1 + gstRate / 100));
  const tax = round2(gross - taxable);
  const cgst = round2(tax / 2);
  const sgst = round2(tax - cgst); // absorbs the odd paise so cgst+sgst === tax
  return { gross, taxable, tax, cgst, sgst };
}

export function inr(n: number): string {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
