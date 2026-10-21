import { createHash } from "node:crypto";
import bs58 from "bs58";

export const MIN_HOLD_BPS = 10n;

export type Holder = { wallet: string; amount: bigint };

export const seedFromSignature = (signature: string) => createHash("sha256").update(bs58.decode(signature)).digest();

export const seedHex = (seed: Uint8Array) => Buffer.from(seed).toString("hex");

export const eligibleHolders = (holders: Holder[], supply: bigint, excluded: Set<string>) => {
  const min = supply > 0n ? (supply * MIN_HOLD_BPS) / 10_000n : 1n;
  return holders
    .filter((holder) => holder.amount >= min && !excluded.has(holder.wallet))
    .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
};

export const pickWinner = (holders: Holder[], seed: Uint8Array) => {
  const total = holders.reduce((sum, holder) => sum + holder.amount, 0n);
  if (total <= 0n || holders.length === 0) return null;
  let roll = 0n;
  for (const byte of seed) roll = (roll << 8n) + BigInt(byte);
  let cursor = roll % total;
  for (const holder of holders) {
    if (cursor < holder.amount) return holder.wallet;
    cursor -= holder.amount;
  }
  return holders[holders.length - 1]?.wallet ?? null;
};
