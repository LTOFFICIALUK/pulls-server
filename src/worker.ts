import { config } from "./config.js";
import { sql } from "./db.js";
import { claimAndSwap } from "./fees.js";
import { openReadyPacks, resumePacks } from "./packs.js";

let running = false;

export const tick = async () => {
  if (running) return;
  running = true;
  const lock = await sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(84218421) AS locked`;
  if (!lock[0]?.locked) {
    console.error("tick", "busy");
    running = false;
    return;
  }
  try {
    await resumePacks();
    await claimAndSwap();
    await openReadyPacks();
  } catch (err) {
    console.error("tick", err instanceof Error ? err.message : "tick");
  } finally {
    await sql`SELECT pg_advisory_unlock(84218421)`.catch(() => undefined);
    running = false;
  }
};

export const startWorker = () => {
  void tick();
  setInterval(() => void tick(), config.loopMs);
};
