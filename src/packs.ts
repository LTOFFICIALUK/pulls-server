import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { config } from "./config.js";
import { asBigint, sql } from "./db.js";
import { buybackTx, cheapestMachine, generatePack, openPack, packPaid, submitGacha, type OpenedPack } from "./gacha.js";
import { gradeLabel } from "./grade.js";
import { snapshotHolders } from "./holders.js";
import { USDC_MINT, tokenBalance } from "./jupiter.js";
import { requireVault, vaultKeypair } from "./keys.js";
import { readCard, transferCard } from "./nft.js";
import { nextPackAction } from "./packs-state.js";
import { dollarsToRaw } from "./split.js";
import { eligibleHolders, pickWinner, seedFromSignature, seedHex } from "./winner.js";

type PackRow = {
  id: string;
  memo: string;
  mint: string;
  symbol: string;
  pack_type: string;
  price_usdc: string;
  debited: boolean;
  status: string;
  unsigned_tx: string | null;
  signed_tx: string | null;
  pay_signature: string | null;
  nft_address: string | null;
  winner: string | null;
  seed: string | null;
  opened_at: Date | null;
  created_at: Date;
};

const signGacha = (base64: string) => {
  const vault = requireVault();
  const raw = Buffer.from(base64, "base64");
  try {
    const tx = Transaction.from(raw);
    tx.partialSign(vault);
    return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
  } catch {
    const tx = VersionedTransaction.deserialize(raw);
    tx.sign([vault]);
    return Buffer.from(tx.serialize()).toString("base64");
  }
};

const cardFields = (opened: OpenedPack) => {
  const metadata = opened.nftWon?.content?.metadata;
  const image = opened.nftWon?.content?.links?.image || opened.nftWon?.content?.files?.[0]?.uri || opened.nftWon?.image || "";
  return {
    name: metadata?.name || "",
    image,
    grade: gradeLabel(metadata?.attributes || [], opened.rarity),
    rarity: opened.rarity || "",
    roll: opened.roll == null ? "" : String(opened.roll),
  };
};

const inflightPacks = () =>
  sql<PackRow[]>`
    SELECT p.id, p.memo, p.mint, c.symbol, p.pack_type, p.price_usdc, p.debited, p.status,
           p.unsigned_tx, p.signed_tx, p.pay_signature, p.nft_address, p.winner, p.seed, p.opened_at, p.created_at
    FROM packs p
    JOIN coins c ON c.mint = p.mint
    WHERE p.status IN ('quoted', 'signed', 'submitted', 'opened')
    ORDER BY p.created_at ASC
  `;

const packByMemo = (memo: string) =>
  sql<PackRow[]>`
    SELECT p.id, p.memo, p.mint, c.symbol, p.pack_type, p.price_usdc, p.debited, p.status,
           p.unsigned_tx, p.signed_tx, p.pay_signature, p.nft_address, p.winner, p.seed, p.opened_at, p.created_at
    FROM packs p
    JOIN coins c ON c.mint = p.mint
    WHERE p.memo = ${memo}
  `;

const refund = async (pack: PackRow, reason: string) => {
  await sql.begin(async (tx) => {
    if (pack.debited) {
      await tx`
        UPDATE coins
        SET pack_balance_usdc = pack_balance_usdc + ${pack.price_usdc}::bigint, updated_at = now()
        WHERE mint = ${pack.mint}
      `;
    }
    await tx`
      UPDATE packs
      SET status = 'abandoned', debited = false, error = ${reason}, updated_at = now()
      WHERE id = ${pack.id} AND status <> 'sent'
    `;
  });
};

const rememberOpen = async (pack: PackRow, opened: OpenedPack) => {
  const card = cardFields(opened);
  const chain = pack.nft_address ? null : await readCard(opened.nft_address || "").catch(() => null);
  const status = await packPaid(pack.memo).catch(() => null);
  await sql`
    UPDATE packs SET
      status = 'opened',
      nft_address = ${opened.nft_address || pack.nft_address},
      nft_name = ${chain?.name || card.name},
      nft_image = ${chain?.image || card.image},
      grade = ${chain?.grade || card.grade},
      rarity = ${card.rarity},
      roll = ${card.roll},
      open_signature = ${opened.transactionSignature || status?.openSignature || null},
      pay_signature = COALESCE(pay_signature, ${status?.paySignature || null}),
      insured_value_usd = COALESCE(${status?.insured ?? null}, insured_value_usd),
      opened_at = COALESCE(opened_at, now()),
      updated_at = now()
    WHERE id = ${pack.id}
  `;
};

const chooseWinner = async (pack: PackRow) => {
  if (pack.winner && pack.seed) return pack.winner;
  const signature = pack.pay_signature;
  if (!signature) throw new Error("The pack payment is not on chain yet.");
  const vault = requireVault();
  const snap = await snapshotHolders(new PublicKey(pack.mint), vault.publicKey.toBase58());
  const creators = await sql<{ creator: string }[]>`SELECT creator FROM coins WHERE creator_index IS NOT NULL`;
  for (const row of creators) {
    if (row.creator) snap.excluded.push(row.creator);
  }
  const eligible = eligibleHolders(snap.holders, snap.supply, new Set(snap.excluded));
  const seed = seedFromSignature(signature);
  const winner = pickWinner(eligible, seed);
  if (!winner) throw new Error("The pack is open. A winner is drawn when a holder has at least 0.1 percent of supply.");
  const snapshot = eligible.map((holder) => ({ wallet: holder.wallet, amount: holder.amount.toString() }));
  await sql`
    UPDATE packs
    SET winner = ${winner},
        seed = ${seedHex(seed)},
        snapshot = ${JSON.stringify(snapshot)}::jsonb,
        excluded = ${JSON.stringify(snap.excluded)}::jsonb,
        updated_at = now()
    WHERE id = ${pack.id}
  `;
  await sql`
    UPDATE coins SET holder_count = ${snap.holders.length}, holders_at = now(), updated_at = now() WHERE mint = ${pack.mint}
  `;
  return winner;
};

const deliver = async (pack: PackRow) => {
  if (!pack.nft_address) {
    const opened = await openPack(pack.memo, 60_000);
    if (!opened?.nft_address) return;
    await rememberOpen(pack, opened);
    pack.nft_address = opened.nft_address;
    pack.pay_signature = pack.pay_signature || opened.transactionSignature || null;
  }
  const winner = await chooseWinner(pack);
  const vault = requireVault();
  const signature = await transferCard(vault, pack.nft_address, winner);
  await sql`
    UPDATE packs
    SET status = 'sent', winner = ${winner}, transfer_signature = ${signature}, updated_at = now()
    WHERE id = ${pack.id}
  `;
};

const resumeOne = async (pack: PackRow) => {
  const known = await packPaid(pack.memo).catch(() => null);
  const action = nextPackAction({
    status: pack.status,
    ageMs: Date.now() - new Date(pack.created_at).getTime(),
    paid: known ? known.paid : null,
  });
  if (action === "done") return;
  if (action === "refund") {
    await refund(pack, "The pack quote expired before payment.");
    return;
  }
  if (action === "open" || action === "transfer" || known?.paid) {
    if (known?.paySignature && !pack.pay_signature) {
      await sql`UPDATE packs SET pay_signature = ${known.paySignature}, updated_at = now() WHERE id = ${pack.id}`;
      pack.pay_signature = known.paySignature;
    }
    await deliver(pack);
    return;
  }
  if ((action === "sign" || action === "submit") && pack.unsigned_tx) {
    const signed = pack.signed_tx || signGacha(pack.unsigned_tx);
    await sql`UPDATE packs SET signed_tx = ${signed}, status = 'signed', updated_at = now() WHERE id = ${pack.id}`;
    const result = await submitGacha(signed);
    await sql`
      UPDATE packs
      SET status = 'submitted', pay_signature = ${result.signature || null}, updated_at = now()
      WHERE id = ${pack.id}
    `;
    pack.pay_signature = result.signature || pack.pay_signature;
    pack.status = "submitted";
    await deliver(pack);
  }
};

export const resumePacks = async () => {
  if (!vaultKeypair()) return;
  const packs = await inflightPacks();
  for (const pack of packs) {
    try {
      await resumeOne(pack);
    } catch (err) {
      const message = err instanceof Error ? err.message : "resume";
      console.error("pack", pack.memo, message);
      await sql`UPDATE packs SET error = ${message}, updated_at = now() WHERE id = ${pack.id}`;
    }
  }
};

const spendable = async () => {
  const vault = requireVault();
  const [balance, treasury] = await Promise.all([
    tokenBalance(vault.publicKey, USDC_MINT),
    sql<{ platform_owed_usdc: string; pulls_owed_usdc: string }[]>`SELECT platform_owed_usdc, pulls_owed_usdc FROM treasury WHERE id = 1`,
  ]);
  const reserved = asBigint(treasury[0]?.platform_owed_usdc) + asBigint(treasury[0]?.pulls_owed_usdc);
  return balance > reserved ? balance - reserved : 0n;
};

export const openReadyPacks = async () => {
  if (!vaultKeypair()) return;
  const machine = await cheapestMachine();
  if (!machine) return;
  const price = dollarsToRaw(machine.price);
  if (price <= 0n) return;
  const coins = await sql<{ mint: string; pack_balance_usdc: string }[]>`
    SELECT mint, pack_balance_usdc FROM coins
    WHERE pack_balance_usdc >= ${price.toString()}::bigint
      AND mint IS DISTINCT FROM ${config.pullsMint}
    ORDER BY pack_balance_usdc DESC
  `;
  const vault = requireVault();
  for (const coin of coins) {
    const busy = await sql`SELECT 1 FROM packs WHERE mint = ${coin.mint} AND status IN ('quoted', 'signed', 'submitted', 'opened')`;
    if (busy.length) continue;
    if ((await spendable()) < price) return;
    const generated = await generatePack(vault.publicKey.toBase58(), machine.code);
    const inserted = await sql.begin(async (tx) => {
      const debited = await tx`
        UPDATE coins
        SET pack_balance_usdc = pack_balance_usdc - ${price.toString()}::bigint, updated_at = now()
        WHERE mint = ${coin.mint} AND pack_balance_usdc >= ${price.toString()}::bigint
        RETURNING mint
      `;
      if (!debited.length) return false;
      await tx`
        INSERT INTO packs (memo, mint, pack_type, price_usdc, instant_buyback, debited, status, unsigned_tx)
        VALUES (
          ${generated.memo},
          ${coin.mint},
          ${machine.code},
          ${price.toString()}::bigint,
          ${machine.instantBuyback},
          true,
          'quoted',
          ${generated.transaction}
        )
      `;
      return true;
    });
    if (!inserted) continue;
    const rows = await packByMemo(generated.memo);
    const pack = rows[0];
    if (!pack) continue;
    try {
      await resumeOne(pack);
    } catch (err) {
      console.error("open", coin.mint, err instanceof Error ? err.message : "open");
    }
  }
};

const verifyMessage = (wallet: string, message: string, signature: string) => {
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bs58.decode(wallet)]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(message), key, bs58.decode(signature));
};

const ownedPack = async (id: string, wallet: string) => {
  const rows = await sql<
    { id: string; winner: string | null; nft_address: string | null; choice: string | null; opened_at: Date | null; status: string }[]
  >`SELECT id, winner, nft_address, choice, opened_at, status FROM packs WHERE id = ${id}`;
  const pack = rows[0];
  if (!pack || pack.status !== "sent" || !pack.nft_address || !pack.winner) throw new Error("This card is still on its way to the winner.");
  if (pack.winner !== wallet) throw new Error("This card belongs to another wallet.");
  if (pack.choice) throw new Error("This card already has a choice.");
  return pack;
};

export const keepMessage = (nft: string) => `Keep card ${nft}`;

export const keepCard = async (id: string, wallet: string, signature: string) => {
  const pack = await ownedPack(id, wallet);
  const message = keepMessage(pack.nft_address || "");
  if (!verifyMessage(wallet, message, signature)) throw new Error("Sign the keep message with the winning wallet.");
  await sql`UPDATE packs SET choice = 'keep', choice_at = now(), updated_at = now() WHERE id = ${id}`;
  return { choice: "keep" };
};

export const cashOut = async (id: string, wallet: string) => {
  const pack = await ownedPack(id, wallet);
  const opened = pack.opened_at ? new Date(pack.opened_at).getTime() : 0;
  if (!opened || Date.now() - opened > 72 * 60 * 60 * 1000) throw new Error("The 72 hour cash out window has closed.");
  const built = await buybackTx(wallet, pack.nft_address || "");
  return { transaction: built.serializedTransaction, refundAmount: built.refundAmount.toString() };
};

export const submitCashOut = async (id: string, wallet: string, signedTransaction: string) => {
  const pack = await ownedPack(id, wallet);
  const result = await submitGacha(signedTransaction);
  await sql`
    UPDATE packs
    SET choice = 'cashout', choice_at = now(), buyback_signature = ${result.signature || null}, updated_at = now()
    WHERE id = ${pack.id}
  `;
  return { choice: "cashout", signature: result.signature || null };
};
