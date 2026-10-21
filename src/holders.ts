import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import { canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import { config } from "./config.js";
import { rpc } from "./chain.js";
import { CARDS_MINT } from "./jupiter.js";
import type { Holder } from "./winner.js";

const readAccounts = async (programId: PublicKey, mint: PublicKey) => {
  const accounts = await rpc().getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
    dataSlice: { offset: 32, length: 40 },
  });
  const rows: Holder[] = [];
  for (const account of accounts) {
    const data = account.account.data;
    if (data.length < 40) continue;
    const wallet = new PublicKey(data.subarray(0, 32)).toBase58();
    const amount = data.readBigUInt64LE(32);
    if (amount > 0n) rows.push({ wallet, amount });
  }
  return rows;
};

export const excludedOwners = (mint: PublicKey, vault: string) => {
  const owners = new Set<string>([vault]);
  if (config.platformWallet) owners.add(config.platformWallet);
  owners.add(bondingCurvePda(mint).toBase58());
  owners.add(canonicalPumpPoolPda(mint, CARDS_MINT).toBase58());
  owners.add(canonicalPumpPoolPda(mint).toBase58());
  return owners;
};

export const snapshotHolders = async (mint: PublicKey, vault: string) => {
  const [legacy, next, supply] = await Promise.all([
    readAccounts(TOKEN_PROGRAM_ID, mint),
    readAccounts(TOKEN_2022_PROGRAM_ID, mint),
    rpc().getTokenSupply(mint),
  ]);
  const merged = new Map<string, bigint>();
  for (const row of [...legacy, ...next]) {
    merged.set(row.wallet, (merged.get(row.wallet) || 0n) + row.amount);
  }
  const holders = [...merged.entries()].map(([wallet, amount]) => ({ wallet, amount }));
  return {
    holders,
    supply: BigInt(supply.value.amount),
    excluded: [...excludedOwners(mint, vault)],
  };
};
