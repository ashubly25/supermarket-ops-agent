import { getPrefs } from "../repo/prefs.js";

/** Shop identity + branding used on invoices and decks. All owner-settable prefs. */
export interface ShopInfo {
  name: string;
  gstin: string;
  address: string;
  phone: string;
  state: string;
  /** Hex without '#', e.g. "1F6FEB". Drives invoice accents and deck theme. */
  brand_color: string;
  /** Free-text line printed at the bottom of every invoice. */
  footer?: string;
  /** classic = light header; modern = full-bleed colour band. */
  template: "classic" | "modern";
}

const HEX = /^#?([0-9a-fA-F]{6})$/;

export function shopInfo(chatId: string): ShopInfo {
  const p = getPrefs(chatId);
  const color = HEX.exec(p.brand_color ?? "")?.[1]?.toUpperCase() ?? "1F6FEB";
  return {
    name: p.shop_name ?? "My Kirana Store",
    gstin: p.gstin ?? "29ABCDE1234F1Z5",
    address: p.shop_address ?? "Main Bazaar Road, Bengaluru, Karnataka - 560001",
    phone: p.shop_phone ?? "+91-90000-00000",
    state: p.shop_state ?? "Karnataka (29)",
    brand_color: color,
    footer: p.invoice_footer,
    template: p.invoice_template === "modern" ? "modern" : "classic",
  };
}

/** Language the owner wants replies in. Invoices stay English (legal document). */
export function language(chatId: string): string {
  return (getPrefs(chatId).language ?? "english").toLowerCase();
}
