import { createHmac } from "node:crypto";
import { Keypair } from "@solana/web3.js";

export const deriveCreator = (seed: string, index: number) => {
  if (!seed) throw new Error("The creator seed is not configured yet.");
  if (!Number.isInteger(index) || index < 0) throw new Error("This coin has no creator wallet.");
  const digest = createHmac("sha512", seed).update(`pulls-creator-v1:${index}`).digest();
  return Keypair.fromSeed(digest.subarray(0, 32));
};
