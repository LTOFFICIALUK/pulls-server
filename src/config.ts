import "dotenv/config";

const raw = (value: string | undefined) => (value || "").trim();

const withScheme = (value: string) => (value.startsWith("http://") || value.startsWith("https://") ? value : `https://${value}`);

const heliusRpc = () => {
  const rpc = raw(process.env.HELIUS_RPC);
  const key = raw(process.env.HELIUS_KEY);
  if (rpc) {
    if (!key || rpc.includes("api-key=")) return rpc;
    return `${rpc}${rpc.includes("?") ? "&" : "?"}api-key=${key}`;
  }
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  return "";
};

const port = Number(process.env.PORT || 8080);
const railwayPublic = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN.replace(/^https?:\/\//, "")}`
  : "";

export const config = {
  port,
  publicApiUrl: raw(process.env.PUBLIC_API_URL || railwayPublic || `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
  databaseUrl: raw(process.env.DATABASE_URL),
  corsOrigin: raw(process.env.CORS_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  heliusRpc: heliusRpc(),
  vaultSecret: raw(process.env.VAULT_SECRET_KEY),
  platformWallet: raw(process.env.PLATFORM_WALLET),
  pullsMint: raw(process.env.PULLS_MINT || process.env.PULL_MINT),
  ccApiKey: raw(process.env.CC_API_KEY),
  jupiterApi: withScheme(raw(process.env.JUPITER_API || "lite-api.jup.ag")).replace(/\/+$/, ""),
  gachaApi: "https://gacha.collectorcrypt.com",
  loopMs: 10 * 60 * 1000,
};

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is required");
}
