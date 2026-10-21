import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const migrate = async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  const dir = path.join(root, "migrations");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await sql`SELECT 1 FROM schema_migrations WHERE id = ${file}`;
    if (applied.length) continue;
    await sql.unsafe(fs.readFileSync(path.join(dir, file), "utf8"));
    await sql`INSERT INTO schema_migrations (id) VALUES (${file}) ON CONFLICT DO NOTHING`;
  }
};
