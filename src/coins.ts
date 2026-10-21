import { asBigint, sql } from "./db.js";
import { cheapestMachine } from "./gacha.js";
import { dollarsToRaw, nextPackEtaMs, rawToDollars } from "./split.js";

let priceCache: { at: number; price: bigint } | null = null;

export const packPrice = async () => {
  if (priceCache && Date.now() - priceCache.at < 60_000) return priceCache.price;
  const machine = await cheapestMachine().catch(() => null);
  const price = machine ? dollarsToRaw(machine.price) : 0n;
  priceCache = { at: Date.now(), price };
  return price;
};

type CoinRow = {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  image_url: string;
  x_url: string | null;
  pack_balance_usdc: string;
  holder_count: number;
  created_at: Date;
  pulls: string;
  vault_usd: string;
};

const coinsSql = async () =>
  sql<CoinRow[]>`
    SELECT c.mint, c.name, c.symbol, c.description, c.image_url, c.x_url, c.pack_balance_usdc, c.holder_count, c.created_at,
      (SELECT count(*) FROM packs p WHERE p.mint = c.mint AND p.nft_address IS NOT NULL) AS pulls,
      (SELECT COALESCE(SUM(p.insured_value_usd), 0) FROM packs p WHERE p.mint = c.mint AND p.nft_address IS NOT NULL AND (p.choice IS NULL OR p.choice <> 'cashout')) AS vault_usd
    FROM coins c
    ORDER BY c.created_at DESC
  `;

const paceFor = async () => {
  const rows = await sql<{ dest_mint: string; raw: string; span: string }[]>`
    SELECT dest_mint,
           SUM(usdc_raw) AS raw,
           EXTRACT(EPOCH FROM (now() - MIN(created_at))) * 1000 AS span
    FROM ledger
    WHERE kind IN ('coin_pack', 'pulls_pack')
      AND dest_mint IS NOT NULL
      AND created_at > now() - interval '24 hours'
    GROUP BY dest_mint
  `;
  const pace = new Map<string, number>();
  for (const row of rows) {
    const span = Math.max(Number(row.span) || 0, 60_000);
    pace.set(row.dest_mint, Number(row.raw) / span);
  }
  return pace;
};

const presentCoin = (row: CoinRow, price: bigint, pace: Map<string, number>) => {
  const balance = asBigint(row.pack_balance_usdc);
  return {
    mint: row.mint,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    imageUrl: row.image_url,
    xUrl: row.x_url,
    holders: row.holder_count,
    pulls: Number(row.pulls),
    vaultUsd: Number(row.vault_usd),
    packBalanceUsdc: rawToDollars(balance),
    packPriceUsdc: rawToDollars(price),
    etaMs: price > 0n ? nextPackEtaMs(balance, price, pace.get(row.mint) || 0) : null,
    createdAt: row.created_at,
  };
};

export const listCoins = async () => {
  const [rows, price, pace] = await Promise.all([coinsSql(), packPrice(), paceFor()]);
  return rows.map((row) => presentCoin(row, price, pace));
};

export const getCoin = async (mint: string) => {
  const [rows, price, pace, pulls] = await Promise.all([
    sql<CoinRow[]>`
      SELECT c.mint, c.name, c.symbol, c.description, c.image_url, c.x_url, c.pack_balance_usdc, c.holder_count, c.created_at,
        (SELECT count(*) FROM packs p WHERE p.mint = c.mint AND p.nft_address IS NOT NULL) AS pulls,
        (SELECT COALESCE(SUM(p.insured_value_usd), 0) FROM packs p WHERE p.mint = c.mint AND p.nft_address IS NOT NULL AND (p.choice IS NULL OR p.choice <> 'cashout')) AS vault_usd
      FROM coins c WHERE c.mint = ${mint}
    `,
    packPrice(),
    paceFor(),
    listPulls(mint),
  ]);
  const row = rows[0];
  if (!row) return null;
  return { coin: presentCoin(row, price, pace), pulls };
};

type PullRow = {
  id: string;
  mint: string;
  symbol: string;
  grade: string | null;
  rarity: string | null;
  winner: string | null;
  nft_address: string | null;
  nft_name: string | null;
  nft_image: string | null;
  insured_value_usd: string | null;
  transfer_signature: string | null;
  open_signature: string | null;
  pay_signature: string | null;
  choice: string | null;
  opened_at: Date | null;
  created_at: Date;
};

const presentPull = (row: PullRow) => ({
  id: row.id,
  mint: row.mint,
  symbol: row.symbol,
  grade: row.grade || row.rarity || "Graded card",
  rarity: row.rarity,
  winner: row.winner,
  nft: row.nft_address,
  name: row.nft_name,
  image: row.nft_image,
  insuredUsd: row.insured_value_usd == null ? null : Number(row.insured_value_usd),
  transferSignature: row.transfer_signature,
  openSignature: row.open_signature,
  paySignature: row.pay_signature,
  choice: row.choice,
  openedAt: row.opened_at,
  createdAt: row.created_at,
});

const pullQuery = (mint?: string) => {
  const select = sql<PullRow[]>`
    SELECT p.id, p.mint, c.symbol, p.grade, p.rarity, p.winner, p.nft_address, p.nft_name, p.nft_image,
           p.insured_value_usd, p.transfer_signature, p.open_signature, p.pay_signature, p.choice, p.opened_at, p.created_at
    FROM packs p
    JOIN coins c ON c.mint = p.mint
    WHERE p.nft_address IS NOT NULL
    ORDER BY p.created_at DESC
    LIMIT 100
  `;
  if (!mint) return select;
  return sql<PullRow[]>`
    SELECT p.id, p.mint, c.symbol, p.grade, p.rarity, p.winner, p.nft_address, p.nft_name, p.nft_image,
           p.insured_value_usd, p.transfer_signature, p.open_signature, p.pay_signature, p.choice, p.opened_at, p.created_at
    FROM packs p
    JOIN coins c ON c.mint = p.mint
    WHERE p.nft_address IS NOT NULL AND p.mint = ${mint}
    ORDER BY p.created_at DESC
    LIMIT 100
  `;
};

export const listPulls = async (mint?: string) => (await pullQuery(mint)).map(presentPull);

export const listRecords = async () => {
  const rows = await sql<
    {
      id: string;
      memo: string;
      mint: string;
      symbol: string;
      status: string;
      roll: string | null;
      seed: string | null;
      snapshot: unknown;
      excluded: unknown;
      winner: string | null;
      pay_signature: string | null;
      open_signature: string | null;
      transfer_signature: string | null;
      nft_address: string | null;
      grade: string | null;
      created_at: Date;
    }[]
  >`
    SELECT p.id, p.memo, p.mint, c.symbol, p.status, p.roll, p.seed, p.snapshot, p.excluded, p.winner,
           p.pay_signature, p.open_signature, p.transfer_signature, p.nft_address, p.grade, p.created_at
    FROM packs p
    JOIN coins c ON c.mint = p.mint
    ORDER BY p.created_at DESC
    LIMIT 100
  `;
  return rows.map((row) => ({
    id: row.id,
    memo: row.memo,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    roll: row.roll,
    seed: row.seed,
    snapshot: row.snapshot,
    excluded: row.excluded,
    winner: row.winner,
    paySignature: row.pay_signature,
    openSignature: row.open_signature,
    transferSignature: row.transfer_signature,
    nft: row.nft_address,
    grade: row.grade,
    createdAt: row.created_at,
  }));
};

export const stats = async () => {
  const [coins, totals, price] = await Promise.all([
    listCoins(),
    sql<{ cards: string; insured: string }[]>`
      SELECT
        count(*) FILTER (WHERE nft_address IS NOT NULL) AS cards,
        COALESCE(SUM(insured_value_usd) FILTER (WHERE nft_address IS NOT NULL AND (choice IS NULL OR choice <> 'cashout')), 0) AS insured
      FROM packs
    `,
    packPrice(),
  ]);
  const ready = coins
    .filter((coin) => coin.etaMs != null)
    .sort((a, b) => (a.etaMs ?? Number.MAX_SAFE_INTEGER) - (b.etaMs ?? Number.MAX_SAFE_INTEGER));
  const next = ready[0] || null;
  return {
    cards: Number(totals[0]?.cards || 0),
    insuredUsd: Number(totals[0]?.insured || 0),
    coins: coins.length,
    packPriceUsdc: rawToDollars(price),
    nextPack: next
      ? { mint: next.mint, symbol: next.symbol, etaMs: next.etaMs, balanceUsdc: next.packBalanceUsdc, priceUsdc: next.packPriceUsdc }
      : { mint: null, symbol: null, etaMs: null, balanceUsdc: 0, priceUsdc: rawToDollars(price) },
  };
};
