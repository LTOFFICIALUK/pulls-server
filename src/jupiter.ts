import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { config } from "./config.js";
import { rpc, signAndSend } from "./chain.js";
import { requireVault } from "./keys.js";

export const CARDS_MINT = new PublicKey("CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp");
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const SOL_MINT = "So11111111111111111111111111111111111111112";

export const tokenBalance = async (owner: PublicKey, mint: PublicKey) => {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
  const info = await rpc().getTokenAccountBalance(ata).catch(() => null);
  return BigInt(info?.value.amount || 0);
};

type Quote = {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  error?: string;
};

const jupiter = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${config.jupiterApi}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Quote & { swapTransaction?: string; transaction?: string; error?: string };
  if (!res.ok) throw new Error(body.error || "Jupiter did not return this swap.");
  return body;
};

export const quoteSwap = async (input: { inputMint: string; outputMint: string; amount: bigint; taker?: string }) => {
  const params = new URLSearchParams({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: input.amount.toString(),
    slippageBps: "100",
  });
  const quote = await jupiter(`/swap/v1/quote?${params.toString()}`);
  if (!quote.outAmount) throw new Error("Jupiter did not quote this pair.");
  return quote;
};

export const swapTransaction = async (quote: Quote, taker: string) => {
  const body = await jupiter("/swap/v1/swap", {
    method: "POST",
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: taker,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!body.swapTransaction) throw new Error("Jupiter did not build this swap.");
  return body.swapTransaction;
};

export const vaultSwap = async (input: { inputMint: PublicKey; outputMint: PublicKey; amount: bigint }) => {
  const vault = requireVault();
  const quote = await quoteSwap({
    inputMint: input.inputMint.toBase58(),
    outputMint: input.outputMint.toBase58(),
    amount: input.amount,
    taker: vault.publicKey.toBase58(),
  });
  const base64 = await swapTransaction(quote, vault.publicKey.toBase58());
  const { VersionedTransaction } = await import("@solana/web3.js");
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  tx.sign([vault]);
  const connection = rpc();
  const signatureBytes = tx.signatures[0];
  if (!signatureBytes) throw new Error("The swap has no signature.");
  const bs58 = (await import("bs58")).default;
  const signature = bs58.encode(signatureBytes);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmed = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  if (confirmed.value.err) throw new Error("The swap did not land.");
  return { signature, outAmount: BigInt(quote.outAmount || 0), inAmount: BigInt(quote.inAmount || input.amount.toString()) };
};

export const transferUsdc = async (destination: PublicKey, amount: bigint) => {
  if (amount <= 0n) return null;
  const vault = requireVault();
  const from = getAssociatedTokenAddressSync(USDC_MINT, vault.publicKey, true, TOKEN_PROGRAM_ID);
  const to = getAssociatedTokenAddressSync(USDC_MINT, destination, true, TOKEN_PROGRAM_ID);
  const { createTransferCheckedInstruction } = await import("@solana/spl-token");
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(vault.publicKey, to, destination, USDC_MINT, TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(from, USDC_MINT, to, vault.publicKey, amount, 6, [], TOKEN_PROGRAM_ID),
  );
  return signAndSend(tx, [vault]);
};
