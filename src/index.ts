import cors from "cors";
import express from "express";
import { z } from "zod";
import { config } from "./config.js";
import { getCoin, listCoins, listPulls, listRecords, stats } from "./coins.js";
import { buildLaunch, media, metadata, submitLaunch } from "./launch.js";
import { migrate } from "./migrate.js";
import { cashOut, keepCard, keepMessage, submitCashOut } from "./packs.js";
import { publicMessage } from "./public-error.js";
import { vaultKeypair } from "./keys.js";
import { startWorker } from "./worker.js";

const sendError = (res: express.Response, status: number, err: unknown) => {
  const message = publicMessage(err);
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "Check the launch fields and try again." });
    return;
  }
  console.error(res.req?.path || "request", message);
  res.status(status).json({ error: message });
};

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "3mb" }));
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      let host = "";
      try {
        host = new URL(origin).hostname;
      } catch {
        callback(null, false);
        return;
      }
      const allowed =
        config.corsOrigin.includes(origin) ||
        host === "getpulls.fun" ||
        host === "www.getpulls.fun" ||
        host.endsWith(".vercel.app") ||
        host === "localhost" ||
        host === "127.0.0.1";
      callback(null, allowed);
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "pulls" });
});

app.get("/v1/ready", (_req, res) => {
  res.json({
    ok: true,
    vault: Boolean(vaultKeypair()),
    helius: Boolean(config.heliusRpc),
    pullsMint: Boolean(config.pullsMint),
    platform: Boolean(config.platformWallet),
    creatorSeed: Boolean(config.creatorMasterSeed),
  });
});

app.get("/v1/stats", async (_req, res) => {
  try {
    res.json(await stats());
  } catch (err) {
    sendError(res, 500, err);
  }
});

app.get("/v1/coins", async (_req, res) => {
  try {
    res.json({ coins: await listCoins() });
  } catch (err) {
    sendError(res, 500, err);
  }
});

app.get("/v1/coins/:mint", async (req, res) => {
  try {
    const body = await getCoin(req.params.mint);
    if (!body) {
      res.status(404).json({ error: "This coin was not launched here." });
      return;
    }
    res.json(body);
  } catch (err) {
    sendError(res, 500, err);
  }
});

app.get("/v1/pulls", async (_req, res) => {
  try {
    res.json({ pulls: await listPulls() });
  } catch (err) {
    sendError(res, 500, err);
  }
});

app.get("/v1/vault", async (_req, res) => {
  try {
    res.json({ cards: await listPulls() });
  } catch (err) {
    sendError(res, 500, err);
  }
});

app.get("/v1/records", async (_req, res) => {
  try {
    res.json({ records: await listRecords() });
  } catch (err) {
    sendError(res, 500, err);
  }
});

app.get("/v1/media/:id", async (req, res) => {
  try {
    const file = await media(req.params.id);
    if (!file) {
      res.status(404).end();
      return;
    }
    res.setHeader("content-type", file.content_type);
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.end(file.bytes);
  } catch (err) {
    sendError(res, 500, err);
  }
});

app.get("/v1/meta/:id", async (req, res) => {
  try {
    const body = await metadata(req.params.id);
    if (!body) {
      res.status(404).json({ error: "This metadata is not here." });
      return;
    }
    res.json(body);
  } catch (err) {
    sendError(res, 500, err);
  }
});

app.post("/v1/launch/build", async (req, res) => {
  try {
    res.json(await buildLaunch(req.body));
  } catch (err) {
    sendError(res, 400, err);
  }
});

app.post("/v1/launch/submit", async (req, res) => {
  try {
    const body = z.object({ launchId: z.string().min(4), transactions: z.array(z.string().min(20)).min(1).max(3) }).parse(req.body);
    res.json(await submitLaunch(body.launchId, body.transactions));
  } catch (err) {
    sendError(res, 400, err);
  }
});

app.get("/v1/packs/:id/keep-message", async (req, res) => {
  try {
    const rows = await listPulls();
    const pack = rows.find((item) => item.id === req.params.id);
    if (!pack?.nft) {
      res.status(404).json({ error: "This card is not in the vault yet." });
      return;
    }
    res.json({ message: keepMessage(pack.nft) });
  } catch (err) {
    sendError(res, 500, err);
  }
});

app.post("/v1/packs/:id/keep", async (req, res) => {
  try {
    const body = z.object({ wallet: z.string().min(32), signature: z.string().min(20) }).parse(req.body);
    res.json(await keepCard(req.params.id, body.wallet, body.signature));
  } catch (err) {
    sendError(res, 400, err);
  }
});

app.post("/v1/packs/:id/cashout", async (req, res) => {
  try {
    const body = z.object({ wallet: z.string().min(32) }).parse(req.body);
    res.json(await cashOut(req.params.id, body.wallet));
  } catch (err) {
    sendError(res, 400, err);
  }
});

app.post("/v1/packs/:id/cashout/submit", async (req, res) => {
  try {
    const body = z.object({ wallet: z.string().min(32), signedTransaction: z.string().min(20) }).parse(req.body);
    res.json(await submitCashOut(req.params.id, body.wallet, body.signedTransaction));
  } catch (err) {
    sendError(res, 400, err);
  }
});

const listen = async () => {
  await migrate();
  app.listen(config.port, () => {
    console.log("pulls api on", config.port);
  });
  startWorker();
};

listen().catch((err) => {
  console.error(err instanceof Error ? err.message : "start");
  process.exit(1);
});
