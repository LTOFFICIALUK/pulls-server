import { randomBytes } from "node:crypto";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { config } from "./config.js";
import { encodeTx, messagesMatch, pubkey, sendSigned } from "./chain.js";
import { sql } from "./db.js";
import { CARDS_MINT, SOL_MINT, quoteSwap, swapTransaction } from "./jupiter.js";
import { deriveCreator } from "./creator.js";
import { requireVault } from "./keys.js";
import { buildCreate } from "./pump.js";

const idOf = () => randomBytes(9).toString("base64url");

const allocateCreator = async () => {
  if (!config.creatorMasterSeed) throw new Error("The creator seed is not configured yet.");
  const rows = await sql<{ idx: number }[]>`
    UPDATE creator_seq
    SET next_index = next_index + 1
    WHERE id = 1
    RETURNING (next_index - 1) AS idx
  `;
  const index = Number(rows[0]?.idx);
  if (!Number.isInteger(index) || index < 0) throw new Error("The creator index is not ready.");
  return { index, publicKey: deriveCreator(config.creatorMasterSeed, index).publicKey };
};

const imageSchema = z.string().min(32).max(2_200_000);

export const launchSchema = z.object({
  wallet: z.string().min(32).max(50),
  name: z.string().trim().min(1).max(32),
  symbol: z.string().trim().min(1).max(13).regex(/^[A-Za-z0-9]+$/),
  description: z.string().trim().max(500).optional().default(""),
  xUrl: z.string().trim().max(200).optional().default(""),
  website: z.string().trim().max(200).optional().default(""),
  image: imageSchema,
  devBuySol: z.number().min(0).max(100).optional().default(0),
  vanity: z.string().trim().max(2).optional().default(""),
});

export type LaunchInput = z.infer<typeof launchSchema>;

const parseImage = (image: string) => {
  const match = image.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!match) throw new Error("Use a PNG, JPG, or WebP image.");
  const type = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length < 32 || bytes.length > 1_500_000) throw new Error("Use an image under 1.5 MB.");
  return { type, bytes };
};

const cleanWebsite = (value: string) => {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The website needs a full https address.");
  }
  if (url.protocol !== "https:") throw new Error("The website needs a full https address.");
  if (!url.hostname.includes(".")) throw new Error("The website needs a full https address.");
  return url.toString();
};

const cleanLink = (value: string) => {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The X link needs a full https address.");
  }
  if (url.protocol !== "https:") throw new Error("The X link needs a full https address.");
  if (url.hostname !== "x.com" && url.hostname !== "twitter.com" && url.hostname !== "www.x.com") {
    throw new Error("The X link needs to be an x.com profile.");
  }
  return url.toString();
};

const grind = (suffix: string) => {
  const want = suffix.toLowerCase();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const key = Keypair.generate();
    if (key.publicKey.toBase58().toLowerCase().endsWith(want)) return key;
  }
  return null;
};

const metaJson = (input: { name: string; symbol: string; description: string; image: string; xUrl: string; website: string }) => ({
  name: input.name,
  symbol: input.symbol,
  description: input.description,
  image: input.image,
  showName: true,
  twitter: input.xUrl || undefined,
  website: input.website || undefined,
});

const uploadIpfs = async (input: { name: string; symbol: string; description: string; xUrl: string; website: string; type: string; bytes: Buffer }) => {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(input.bytes)], { type: input.type }), "coin.png");
  form.append("name", input.name);
  form.append("symbol", input.symbol);
  form.append("description", input.description);
  form.append("showName", "true");
  if (input.xUrl) form.append("twitter", input.xUrl);
  if (input.website) form.append("website", input.website);
  const res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
  if (!res.ok) return null;
  const body = (await res.json()) as { metadataUri?: string };
  if (!body.metadataUri || body.metadataUri.length > 200) return null;
  return body.metadataUri;
};

export const buildLaunch = async (raw: unknown) => {
  const input = launchSchema.parse(raw);
  const wallet = pubkey(input.wallet, "Your wallet");
  requireVault();
  const image = parseImage(input.image);
  const xUrl = cleanLink(input.xUrl || "");
  const website = cleanWebsite(input.website || "");
  const symbol = input.symbol.toUpperCase();
  const launchId = idOf();
  const mint = input.vanity ? grind(input.vanity) : Keypair.generate();
  if (!mint) throw new Error("No mint ending in that suffix yet. Try again, or launch without vanity.");

  await sql`INSERT INTO assets (id, content_type, bytes) VALUES (${launchId}, ${image.type}, ${image.bytes})`;
  const imageUrl = `${config.publicApiUrl}/v1/media/${launchId}`;
  const hostedUri = `${config.publicApiUrl}/v1/meta/${launchId}`;
  const ipfs = await uploadIpfs({ ...input, symbol, xUrl, website, type: image.type, bytes: image.bytes }).catch(() => null);
  const metadataUri = ipfs || hostedUri;
  if (metadataUri.length > 200) throw new Error("The metadata address is too long for pump.fun.");

  const transactions: { kind: "swap" | "create"; tx: string }[] = [];
  let quoteRaw = 0n;
  if (input.devBuySol > 0) {
    const lamports = BigInt(Math.round(input.devBuySol * 1_000_000_000));
    const quote = await quoteSwap({
      inputMint: SOL_MINT,
      outputMint: CARDS_MINT.toBase58(),
      amount: lamports,
      taker: wallet.toBase58(),
    });
    quoteRaw = BigInt(quote.otherAmountThreshold || quote.outAmount || 0);
    if (quoteRaw <= 0n) throw new Error("Jupiter did not quote a CARDS amount for this dev buy.");
    transactions.push({ kind: "swap", tx: await swapTransaction(quote, wallet.toBase58()) });
  }
  const creator = await allocateCreator();
  transactions.push({
    kind: "create",
    tx: await buildCreate({
      mint,
      user: wallet,
      creator: creator.publicKey,
      name: input.name,
      symbol,
      uri: metadataUri,
      quoteRaw,
    }),
  });

  await sql`
    INSERT INTO launches (id, wallet, mint, name, symbol, description, x_url, website_url, image_id, metadata_uri, dev_buy_sol, creator, creator_index, transactions)
    VALUES (
      ${launchId},
      ${wallet.toBase58()},
      ${mint.publicKey.toBase58()},
      ${input.name},
      ${symbol},
      ${input.description || ""},
      ${xUrl || null},
      ${website || null},
      ${launchId},
      ${metadataUri},
      ${input.devBuySol},
      ${creator.publicKey.toBase58()},
      ${creator.index},
      ${JSON.stringify(transactions)}::jsonb
    )
  `;

  return {
    launchId,
    mint: mint.publicKey.toBase58(),
    creator: creator.publicKey.toBase58(),
    metadataUri,
    transactions: transactions.map((item) => ({ kind: item.kind, tx: item.tx })),
  };
};

const signedBy = (raw: Buffer, key: PublicKey) => {
  try {
    const tx = Transaction.from(raw);
    return tx.signatures.some((item) => item.publicKey.equals(key) && Boolean(item.signature));
  } catch {
    const tx = VersionedTransaction.deserialize(raw);
    const index = tx.message.staticAccountKeys.findIndex((account) => account.equals(key));
    if (index < 0) return false;
    const signature = tx.signatures[index];
    return Boolean(signature && signature.some((byte) => byte !== 0));
  }
};

export const submitLaunch = async (launchId: string, signed: string[]) => {
  const rows = await sql<
    {
      id: string;
      wallet: string;
      mint: string;
      name: string;
      symbol: string;
      description: string;
      x_url: string | null;
      metadata_uri: string;
      website_url: string | null;
      dev_buy_sol: string;
      creator: string | null;
      creator_index: number | null;
      transactions: { kind: string; tx: string }[];
      status: string;
    }[]
  >`SELECT * FROM launches WHERE id = ${launchId}`;
  const launch = rows[0];
  if (!launch) throw new Error("This launch has expired. Build it again.");
  if (launch.status === "live") return { mint: launch.mint, signature: null, already: true };
  const expected = launch.transactions || [];
  if (signed.length !== expected.length) throw new Error("Sign every transaction in this launch.");
  if (!launch.creator || launch.creator_index == null) throw new Error("Build this launch again.");
  const wallet = new PublicKey(launch.wallet);
  const mint = new PublicKey(launch.mint);
  const signatures: string[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const item = expected[index];
    const raw = signed[index];
    if (!item || !raw || !messagesMatch(item.tx, raw)) throw new Error("The signed launch does not match the one we built.");
    const bytes = Buffer.from(raw, "base64");
    if (!signedBy(bytes, wallet)) throw new Error("Sign the launch with the wallet that started it.");
    if (item.kind === "create" && !signedBy(bytes, mint)) throw new Error("The mint did not sign this launch.");
    signatures.push(await sendSigned(raw));
  }
  const signature = signatures[signatures.length - 1] || null;
  await sql`
    INSERT INTO coins (mint, name, symbol, description, image_url, metadata_uri, x_url, website_url, launcher, creator, creator_index, launch_signature, dev_buy_sol)
    VALUES (
      ${launch.mint},
      ${launch.name},
      ${launch.symbol},
      ${launch.description},
      ${`${config.publicApiUrl}/v1/media/${launch.id}`},
      ${launch.metadata_uri},
      ${launch.x_url},
      ${launch.website_url},
      ${launch.wallet},
      ${launch.creator},
      ${launch.creator_index},
      ${signature},
      ${launch.dev_buy_sol}
    )
    ON CONFLICT (mint) DO NOTHING
  `;
  await sql`UPDATE launches SET status = 'live' WHERE id = ${launch.id}`;
  return { mint: launch.mint, signature, already: false };
};

export const media = async (id: string) => {
  const rows = await sql<{ content_type: string; bytes: Buffer }[]>`SELECT content_type, bytes FROM assets WHERE id = ${id}`;
  return rows[0] || null;
};

export const metadata = async (id: string) => {
  const rows = await sql<
    { name: string; symbol: string; description: string; x_url: string | null; website_url: string | null }[]
  >`SELECT name, symbol, description, x_url, website_url FROM launches WHERE id = ${id}`;
  const row = rows[0];
  if (!row) return null;
  return metaJson({
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    image: `${config.publicApiUrl}/v1/media/${id}`,
    xUrl: row.x_url || "",
    website: row.website_url || "",
  });
};
