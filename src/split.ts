export const COIN_BPS = 9000n;
export const PLATFORM_BPS = 1000n;

export const splitUsdc = (amount: bigint) => {
  if (amount <= 0n) return { coin: 0n, pulls: 0n, platform: 0n };
  const coin = (amount * COIN_BPS) / 10_000n;
  const platform = amount - coin;
  return { coin, pulls: 0n, platform };
};

export const dollarsToRaw = (dollars: number) => {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0n;
  return BigInt(Math.round(dollars * 1_000_000));
};

export const rawToDollars = (raw: bigint) => Number(raw) / 1_000_000;

export const nextPackEtaMs = (balance: bigint, price: bigint, usdcPerMs: number) => {
  if (price <= 0n) return null;
  if (balance >= price) return 0;
  if (!Number.isFinite(usdcPerMs) || usdcPerMs <= 0) return null;
  return Math.ceil(Number(price - balance) / usdcPerMs);
};
