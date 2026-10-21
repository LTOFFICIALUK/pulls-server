import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  isBondingCurveMigrated,
} from "@pump-fun/pump-sdk";
import { canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import { feeClaimPlan } from "./claim-plan.js";
import { encodeTx, rpc, signAndSend } from "./chain.js";
import { CARDS_MINT, tokenBalance } from "./jupiter.js";
import { requireVault } from "./keys.js";

const online = () => new OnlinePumpSdk(rpc());

export const curveAddress = (mint: PublicKey) => bondingCurvePda(mint);
export const poolAddress = (mint: PublicKey) => canonicalPumpPoolPda(mint, CARDS_MINT);

const packTx = (input: { user: PublicKey; mint?: Keypair; blockhash: string; instructions: TransactionInstruction[] }) => {
  const tx = new Transaction({ feePayer: input.user, recentBlockhash: input.blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ...input.instructions,
  );
  if (input.mint) tx.partialSign(input.mint);
  return encodeTx(tx);
};

export const buildCreate = async (input: {
  mint: Keypair;
  user: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  quoteRaw?: bigint;
}) => {
  const sdk = online();
  const resolved = await sdk.resolveQuoteMint(CARDS_MINT).catch(() => null);
  const quoteTokenProgram = resolved?.quoteTokenProgram || TOKEN_PROGRAM_ID;
  const pumpQuote = resolved?.pumpQuote?.accounts;
  const { blockhash } = await rpc().getLatestBlockhash("confirmed");
  const createIx = await PUMP_SDK.createV2Instruction({
    mint: input.mint.publicKey,
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    creator: input.creator,
    user: input.user,
    mayhemMode: false,
    quoteMint: CARDS_MINT,
    quoteTokenProgram,
    ...(pumpQuote ? { pumpQuote } : {}),
  });
  const create = packTx({ user: input.user, mint: input.mint, blockhash, instructions: [createIx] });
  if (!input.quoteRaw || input.quoteRaw <= 0n) return { create, buy: null };

  const [global, feeConfig, quoteControl] = await Promise.all([
    sdk.fetchGlobal(),
    sdk.fetchFeeConfig(),
    sdk.fetchQuoteControl().catch(() => null),
  ]);
  const quoteAmount = new BN(input.quoteRaw.toString());
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: quoteAmount,
    quoteMint: CARDS_MINT,
    quoteControl,
    ...(resolved?.pumpQuote ? { pumpQuote: resolved.pumpQuote.curve } : {}),
  });
  if (amount.lten(0)) throw new Error("This dev buy is too small to buy the coin.");
  const combined = await PUMP_SDK.createV2AndBuyV2Instructions({
    global,
    mint: input.mint.publicKey,
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    creator: input.creator,
    user: input.user,
    amount,
    quoteAmount,
    mayhemMode: false,
    quoteMint: CARDS_MINT,
    quoteTokenProgram,
    ...(pumpQuote ? { pumpQuote } : {}),
  });
  const buyIxs = combined.slice(1);
  if (!buyIxs.length) throw new Error("The dev buy could not be built.");
  const buy = packTx({ user: input.user, blockhash, instructions: buyIxs });
  return { create, buy };
};

export const claimCoinFees = async (mint: PublicKey, creator: Keypair) => {
  const vault = requireVault();
  const curveInfo = await rpc().getAccountInfo(bondingCurvePda(mint));
  if (!curveInfo) return null;
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  if (!curve.creator.equals(creator.publicKey)) {
    console.error("claim", mint.toBase58(), "creator on chain differs");
    return null;
  }
  const migrated = curve.complete || isBondingCurveMigrated(curve);
  const balances = await online().getCreatorVaultQuoteBalances(creator.publicKey, [CARDS_MINT]);
  const cards = balances.find((row) => row.mint.equals(CARDS_MINT));
  const pumpRaw = BigInt(cards?.pumpVault.toString() || "0");
  const ammRaw = BigInt(cards?.ammVault.toString() || "0");
  const plan = feeClaimPlan(migrated, pumpRaw, ammRaw);
  if (!plan.collectBonding && !plan.collectPool) return null;
  const built = await online().collectCoinCreatorFeeV2Instructions(
    creator.publicKey,
    CARDS_MINT,
    TOKEN_PROGRAM_ID,
    vault.publicKey,
  );
  const instructions = built.filter((ix) => (ix.programId.equals(PUMP_PROGRAM_ID) ? plan.collectBonding : plan.collectPool));
  if (!instructions.length) return null;
  const creatorAta = getAssociatedTokenAddressSync(CARDS_MINT, creator.publicKey, true, TOKEN_PROGRAM_ID);
  instructions.unshift(
    createAssociatedTokenAccountIdempotentInstruction(
      vault.publicKey,
      creatorAta,
      creator.publicKey,
      CARDS_MINT,
      TOKEN_PROGRAM_ID,
    ),
  );
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...instructions);
  const creatorSigns = instructions.some((ix) => ix.keys.some((key) => key.isSigner && key.pubkey.equals(creator.publicKey)));
  return signAndSend(tx, creatorSigns ? [vault, creator] : [vault], vault.publicKey);
};

export const sweepCreatorCards = async (creator: Keypair) => {
  const vault = requireVault();
  const amount = await tokenBalance(creator.publicKey, CARDS_MINT);
  if (amount <= 0n) return null;
  const from = getAssociatedTokenAddressSync(CARDS_MINT, creator.publicKey, true, TOKEN_PROGRAM_ID);
  const to = getAssociatedTokenAddressSync(CARDS_MINT, vault.publicKey, true, TOKEN_PROGRAM_ID);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(vault.publicKey, to, vault.publicKey, CARDS_MINT, TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(from, CARDS_MINT, to, creator.publicKey, amount, 6, [], TOKEN_PROGRAM_ID),
  );
  return signAndSend(tx, [vault, creator], vault.publicKey);
};
