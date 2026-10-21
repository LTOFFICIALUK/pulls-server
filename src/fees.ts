import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { asBigint, sql } from "./db.js";
import { CARDS_MINT, USDC_MINT, tokenBalance, transferUsdc, vaultSwap } from "./jupiter.js";
import { creatorKeypair, requireVault, vaultKeypair } from "./keys.js";
import { claimCoinFees, sweepCreatorCards } from "./pump.js";
import { splitUsdc } from "./split.js";

export const ensurePullsCoin = async () => {
  if (!config.pullsMint || !config.platformWallet) return;
  await sql`
    INSERT INTO coins (mint, name, symbol, description, launcher, creator, source)
    VALUES (
      ${config.pullsMint},
      'Pulls',
      'PULLS',
      'The Pulls coin.',
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
};

const credit = async (source: string, usdc: bigint, signature: string) => {
  const parts = splitUsdc(usdc);
  await sql.begin(async (tx) => {
    await tx`
      UPDATE coins
      SET pack_balance_usdc = pack_balance_usdc + ${parts.coin.toString()}::bigint, updated_at = now()
      WHERE mint = ${source}
    `;
    await tx`
      UPDATE treasury
      SET platform_owed_usdc = platform_owed_usdc + ${parts.platform.toString()}::bigint, updated_at = now()
      WHERE id = 1
    `;
    await tx`
      INSERT INTO ledger (source_mint, dest_mint, kind, usdc_raw, signature)
      VALUES
        (${source}, ${source}, 'coin_pack', ${parts.coin.toString()}::bigint, ${signature}),
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

const quietClaim = (message: string) => /insufficient|no record|0x0|empty|debit|account not found/i.test(message);

export const claimAndSwap = async () => {
  await ensurePullsCoin();
  if (!vaultKeypair()) return;
  const vault = requireVault();
  if (!config.creatorMasterSeed) {
    console.error("claim", "The creator seed is not configured yet.");
  }
  const coins = await sql<{ mint: string; symbol: string; creator: string; creator_index: number | null }[]>`
    SELECT mint, symbol, creator, creator_index
    FROM coins
    WHERE creator_index IS NOT NULL
      AND mint IS DISTINCT FROM ${config.pullsMint}
    ORDER BY created_at ASC
  `;
  for (const coin of coins) {
    const index = Number(coin.creator_index);
    if (config.creatorMasterSeed && Number.isInteger(index) && index >= 0) {
      const creator = creatorKeypair(index);
      if (creator.publicKey.toBase58() !== coin.creator) {
        console.error("claim", coin.symbol, "creator does not match the seed");
      } else {
        const mint = new PublicKey(coin.mint);
        try {
          await claimCoinFees(mint, creator);
        } catch (err) {
          const message = err instanceof Error ? err.message : "claim";
          if (!quietClaim(message)) console.error("claim", coin.symbol, message);
        }
        const sitting = await tokenBalance(creator.publicKey, CARDS_MINT);
        if (sitting > 0n) {
          try {
            const signature = await sweepCreatorCards(creator);
            if (signature) {
              const inserted = await sql`
                INSERT INTO fee_claims (mint, cards_raw, signature)
                VALUES (${coin.mint}, ${sitting.toString()}::bigint, ${signature})
                ON CONFLICT (signature) DO NOTHING
                RETURNING id
              `;
              if (inserted.length) {
                await sql`
                  UPDATE coins
                  SET cards_pending = cards_pending + ${sitting.toString()}::bigint,
                      cards_claimed = cards_claimed + ${sitting.toString()}::bigint,
                      updated_at = now()
                  WHERE mint = ${coin.mint}
                `;
              }
            }
          } catch (err) {
            console.error("sweep", coin.symbol, err instanceof Error ? err.message : "sweep");
          }
        }
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
