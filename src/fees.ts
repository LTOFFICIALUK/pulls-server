import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { asBigint, sql } from "./db.js";
import { CARDS_MINT, USDC_MINT, tokenBalance, transferUsdc, vaultSwap } from "./jupiter.js";
import { platformKeypair, requireVault, vaultKeypair } from "./keys.js";
import { claimCards } from "./pump.js";
import { splitUsdc } from "./split.js";

export const ensurePullsCoin = async () => {
  if (!config.pullsMint || !config.platformWallet) return;
  await sql`
    INSERT INTO coins (mint, name, symbol, description, launcher, creator, source)
    VALUES (
      ${config.pullsMint},
      'Pulls',
      'PULLS',
      'The Pulls coin. Ten percent of every other coin tops up packs for holders.',
      ${config.platformWallet},
      ${config.platformWallet},
      'proxima'
    )
    ON CONFLICT (mint) DO UPDATE
    SET creator = EXCLUDED.creator,
        launcher = EXCLUDED.launcher,
        description = EXCLUDED.description,
        updated_at = now()
  `;
  const moved = await sql<{ pack_balance_usdc: string }[]>`
    UPDATE coins
    SET pack_balance_usdc = pack_balance_usdc + (SELECT pulls_owed_usdc FROM treasury WHERE id = 1),
        updated_at = now()
    WHERE mint = ${config.pullsMint}
      AND (SELECT pulls_owed_usdc FROM treasury WHERE id = 1) > 0
    RETURNING pack_balance_usdc
  `;
  if (moved.length) {
    await sql`UPDATE treasury SET pulls_owed_usdc = 0, updated_at = now() WHERE id = 1`;
  }
};

const credit = async (source: string, usdc: bigint, signature: string) => {
  const parts = splitUsdc(usdc);
  await sql.begin(async (tx) => {
    await tx`
      UPDATE coins
      SET pack_balance_usdc = pack_balance_usdc + ${parts.coin.toString()}::bigint, updated_at = now()
      WHERE mint = ${source}
    `;
    if (config.pullsMint) {
      await tx`
        UPDATE coins
        SET pack_balance_usdc = pack_balance_usdc + ${parts.pulls.toString()}::bigint, updated_at = now()
        WHERE mint = ${config.pullsMint}
      `;
    } else {
      await tx`
        UPDATE treasury
        SET pulls_owed_usdc = pulls_owed_usdc + ${parts.pulls.toString()}::bigint, updated_at = now()
        WHERE id = 1
      `;
    }
    await tx`
      UPDATE treasury
      SET platform_owed_usdc = platform_owed_usdc + ${parts.platform.toString()}::bigint, updated_at = now()
      WHERE id = 1
    `;
    await tx`
      INSERT INTO ledger (source_mint, dest_mint, kind, usdc_raw, signature)
      VALUES
        (${source}, ${source}, 'coin_pack', ${parts.coin.toString()}::bigint, ${signature}),
        (${source}, ${config.pullsMint || null}, 'pulls_pack', ${parts.pulls.toString()}::bigint, ${signature}),
        (${source}, ${config.platformWallet || null}, 'platform', ${parts.platform.toString()}::bigint, ${signature})
    `;
    await tx`
      UPDATE fee_claims SET usdc_raw = ${usdc.toString()}::bigint WHERE signature = ${signature}
    `;
  });
};

export const flushPlatform = async () => {
  if (!config.platformWallet || !vaultKeypair()) return;
  const rows = await sql<{ platform_owed_usdc: string }[]>`SELECT platform_owed_usdc FROM treasury WHERE id = 1`;
  const owed = asBigint(rows[0]?.platform_owed_usdc);
  if (owed <= 0n) return;
  const vault = requireVault();
  const balance = await tokenBalance(vault.publicKey, USDC_MINT);
  const amount = balance < owed ? balance : owed;
  if (amount <= 0n) return;
  const signature = await transferUsdc(new PublicKey(config.platformWallet), amount);
  await sql`
    UPDATE treasury
    SET platform_owed_usdc = platform_owed_usdc - ${amount.toString()}::bigint, updated_at = now()
    WHERE id = 1
  `;
  await sql`
    INSERT INTO ledger (source_mint, dest_mint, kind, usdc_raw, signature)
    VALUES ('platform', ${config.platformWallet}, 'platform_send', ${amount.toString()}::bigint, ${signature})
  `;
};

const claimPullsForPlatform = async () => {
  const signer = platformKeypair();
  if (!signer || !config.pullsMint) return;
  const before = await tokenBalance(signer.publicKey, CARDS_MINT);
  let signature: string | null = null;
  try {
    signature = await claimCards(new PublicKey(config.pullsMint), signer);
  } catch (err) {
    const message = err instanceof Error ? err.message : "claim";
    if (!/insufficient|no record|0x0|empty|debit/i.test(message)) console.error("claim", "PULLS", message);
  }
  const after = await tokenBalance(signer.publicKey, CARDS_MINT);
  const gained = after > before ? after - before : 0n;
  if (gained <= 0n) return;
  const claimSignature = signature || `platform-${config.pullsMint}-${after.toString()}`;
  await sql`
    INSERT INTO fee_claims (mint, cards_raw, signature)
    VALUES (${config.pullsMint}, ${gained.toString()}::bigint, ${claimSignature})
    ON CONFLICT (signature) DO NOTHING
  `;
};

export const claimAndSwap = async () => {
  await ensurePullsCoin();
  await claimPullsForPlatform();
  if (!vaultKeypair()) return;
  const vault = requireVault();
  const coins = await sql<{ mint: string; symbol: string; cards_pending: string }[]>`
    SELECT mint, symbol, cards_pending FROM coins ORDER BY created_at ASC
  `;
  for (const coin of coins) {
    if (coin.mint === config.pullsMint) continue;
    const mint = new PublicKey(coin.mint);
    const before = await tokenBalance(vault.publicKey, CARDS_MINT);
    let signature: string | null = null;
    try {
      signature = await claimCards(mint, vault);
    } catch (err) {
      const message = err instanceof Error ? err.message : "claim";
      if (!/insufficient|no record|0x0|empty|debit/i.test(message)) {
        console.error("claim", coin.symbol, message);
      }
    }
    const after = await tokenBalance(vault.publicKey, CARDS_MINT);
    const gained = after > before ? after - before : 0n;
    if (gained > 0n) {
      const claimSignature = signature || `balance-${coin.mint}-${after.toString()}`;
      const inserted = await sql`
        INSERT INTO fee_claims (mint, cards_raw, signature)
        VALUES (${coin.mint}, ${gained.toString()}::bigint, ${claimSignature})
        ON CONFLICT (signature) DO NOTHING
        RETURNING id
      `;
      if (inserted.length) {
        await sql`
          UPDATE coins
          SET cards_pending = cards_pending + ${gained.toString()}::bigint,
              cards_claimed = cards_claimed + ${gained.toString()}::bigint,
              updated_at = now()
          WHERE mint = ${coin.mint}
        `;
      }
    }
    const pendingRows = await sql<{ cards_pending: string }[]>`SELECT cards_pending FROM coins WHERE mint = ${coin.mint}`;
    const pending = asBigint(pendingRows[0]?.cards_pending);
    if (pending <= 0n) continue;
    const usdcBefore = await tokenBalance(vault.publicKey, USDC_MINT);
    const cardsBefore = await tokenBalance(vault.publicKey, CARDS_MINT);
    const amount = pending < cardsBefore ? pending : cardsBefore;
    if (amount <= 0n) continue;
    try {
      const swap = await vaultSwap({ inputMint: CARDS_MINT, outputMint: USDC_MINT, amount });
      const usdcAfter = await tokenBalance(vault.publicKey, USDC_MINT);
      const cardsAfter = await tokenBalance(vault.publicKey, CARDS_MINT);
      const spent = cardsBefore > cardsAfter ? cardsBefore - cardsAfter : amount;
      const got = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : swap.outAmount;
      await sql`
        UPDATE coins
        SET cards_pending = GREATEST(cards_pending - ${spent.toString()}::bigint, 0), updated_at = now()
        WHERE mint = ${coin.mint}
      `;
      if (got > 0n) await credit(coin.mint, got, swap.signature);
    } catch (err) {
      console.error("swap", coin.symbol, err instanceof Error ? err.message : "swap");
    }
  }
  await flushPlatform().catch((err) => {
    console.error("platform", err instanceof Error ? err.message : "platform");
  });
};
