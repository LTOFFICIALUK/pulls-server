export type PackPhase = "quoted" | "signed" | "submitted" | "opened" | "sent" | "abandoned";

export type PackAction = "sign" | "submit" | "open" | "transfer" | "refund" | "done";

const QUOTE_TTL_MS = 90_000;
const SUBMIT_TTL_MS = 10 * 60_000;

export const nextPackAction = (pack: { status: string; ageMs: number; paid: boolean | null }): PackAction => {
  if (pack.status === "sent" || pack.status === "abandoned") return "done";
  if (pack.status === "opened") return "transfer";
  if (pack.status === "submitted") {
    if (pack.paid) return "open";
    if (pack.paid === false && pack.ageMs > SUBMIT_TTL_MS) return "refund";
    return "open";
  }
  if (pack.status === "signed") {
    if (pack.paid) return "open";
    if (pack.ageMs > QUOTE_TTL_MS) return "refund";
    return "submit";
  }
  if (pack.status === "quoted") {
    if (pack.paid) return "open";
    if (pack.ageMs > QUOTE_TTL_MS) return "refund";
    return "sign";
  }
  return "done";
};
