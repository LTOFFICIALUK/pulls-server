import {
  createAssociatedTokenAccountIdempotentInstruction,
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
  PUMP_SDK,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
} from "@pump-fun/pump-sdk";
import { canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import { encodeTx, rpc, signAndSend } from "./chain.js";
import { CARDS_MINT } from "./jupiter.js";
import { requireVault } from "./keys.js";

const online = () => new OnlinePumpSdk(rpc());

export const curveAddress = (mint: PublicKey) => bondingCurvePda(mint);
export const poolAddress = (mint: PublicKey) => canonicalPumpPoolPda(mint, CARDS_MINT);

export const buildCreate = async (input: {
  mint: Keypair;
  user: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  quoteRaw?: bigint;
}) => {
  const vault = requireVault();
  const sdk = online();
  const resolved = await sdk.resolveQuoteMint(CARDS_MINT).catch(() => null);
  const quoteTokenProgram = resolved?.quoteTokenProgram || TOKEN_PROGRAM_ID;
  const pumpQuote = resolved?.pumpQuote?.accounts;
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.quoteRaw && input.quoteRaw > 0n ? 800_000 : 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  ];
  if (input.quoteRaw && input.quoteRaw > 0n) {
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
    instructions.push(
      ...(await PUMP_SDK.createV2AndBuyV2Instructions({
        global,
        mint: input.mint.publicKey,
        name: input.name,
        symbol: input.symbol,
        uri: input.uri,
        creator: vault.publicKey,
        user: input.user,
        amount,
        quoteAmount,
        mayhemMode: false,
        quoteMint: CARDS_MINT,
        quoteTokenProgram,
        ...(pumpQuote ? { pumpQuote } : {}),
      })),
    );
  } else {
    instructions.push(
      await PUMP_SDK.createV2Instruction({
        mint: input.mint.publicKey,
        name: input.name,
        symbol: input.symbol,
        uri: input.uri,
        creator: vault.publicKey,
        user: input.user,
        mayhemMode: false,
        quoteMint: CARDS_MINT,
        quoteTokenProgram,
        ...(pumpQuote ? { pumpQuote } : {}),
      }),
    );
  }
  const { blockhash } = await rpc().getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: input.user, recentBlockhash: blockhash }).add(...instructions);
  tx.partialSign(input.mint);
  return encodeTx(tx);
};

export const claimCards = async (mint: PublicKey, signer: Keypair) => {
  const sdk = online();
  const connection = rpc();
  const owner = signer.publicKey;
  const ata = getAssociatedTokenAddressSync(CARDS_MINT, owner, true, TOKEN_PROGRAM_ID);
  const signatures: string[] = [];
  const send = async (instructions: TransactionInstruction[]) => {
    if (!instructions.length) return;
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...instructions);
    signatures.push(await signAndSend(tx, [signer]));
  };
  const sweep = await PUMP_SDK.sweepCreatorFeeInstruction({
    payer: owner,
    mint,
    creator: owner,
    quoteMint: CARDS_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  });
  await send([
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, CARDS_MINT, TOKEN_PROGRAM_ID),
    sweep,
  ]).catch(() => undefined);
  const pool = poolAddress(mint);
  if (await connection.getAccountInfo(pool)) {
    const poolSweep = await PUMP_SDK.sweepPoolCreatorFeeInstruction({
      payer: owner,
      mint,
      coinCreator: owner,
      quoteMint: CARDS_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
    await send([poolSweep]).catch(() => undefined);
  }
  await send(await sdk.collectCoinCreatorFeeV2Instructions(owner, CARDS_MINT, TOKEN_PROGRAM_ID, owner));
  return signatures.at(-1) || null;
};
