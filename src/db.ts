import postgres from "postgres";
import { config } from "./config.js";

const internal = config.databaseUrl.includes("railway.internal");
const local = config.databaseUrl.includes("localhost") || config.databaseUrl.includes("127.0.0.1");

export const sql = postgres(config.databaseUrl, {
  max: 8,
  ssl: local || internal ? false : "require",
});

export const asBigint = (value: string | number | bigint | null | undefined) => {
  if (typeof value === "bigint") return value;
  if (value == null || value === "") return 0n;
  return BigInt(value);
};
