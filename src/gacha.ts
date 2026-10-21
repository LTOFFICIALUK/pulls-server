import { config } from "./config.js";
import { sleep } from "./chain.js";
import { pickMachine, type Machine } from "./machines.js";

type GachaMachine = {
  code?: string;
  price?: number;
  instantBuyback?: number;
  public?: boolean;
};

type GachaStatus = {
  code?: string;
  price?: number;
  status?: string;
  isOpen?: boolean;
};

const headers = () => {
  const value: Record<string, string> = { "content-type": "application/json" };
  if (config.ccApiKey) value["x-api-key"] = config.ccApiKey;
  return value;
};

export const gacha = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${config.gachaApi}${path}`, { ...init, headers: { ...headers(), ...(init?.headers || {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; details?: string; code?: string };
  if (!res.ok) {
    throw new Error(body.details || body.error || "Collector Crypt did not accept this pack.");
  }
  return body;
};

export const cheapestMachine = async () => {
  const [listed, status] = await Promise.all([
    gacha<{ machines?: GachaMachine[] }>("/api/machines"),
    gacha<{ machineStatus?: string; gachas?: GachaStatus[] }>("/api/status"),
  ]);
  if (status.machineStatus === "stopped") return null;
  const details = new Map((listed.machines || []).map((machine) => [machine.code, machine]));
  const machines: Machine[] = (status.gachas || []).map((row) => {
    const extra = details.get(row.code);
    return {
      code: row.code || "",
      price: Number(row.price ?? extra?.price ?? 0),
      instantBuyback: Number(extra?.instantBuyback ?? 0),
      open: Boolean(row.isOpen) || row.status === "open",
      listed: extra ? extra.public !== false : true,
    };
  });
  return pickMachine(machines.filter((machine) => machine.code));
};

export const generatePack = async (player: string, packType: string) =>
  gacha<{ memo: string; transaction: string }>("/api/generatePack", {
    method: "POST",
    body: JSON.stringify({ playerAddress: player, packType }),
  });

export const submitGacha = async (signedTransaction: string) =>
  gacha<{ success?: boolean; signature?: string }>("/api/submitTransaction", {
    method: "POST",
    body: JSON.stringify({ signedTransaction }),
  });

export type OpenedPack = {
  nft_address?: string;
  transactionSignature?: string;
  rarity?: string;
  roll?: number | string;
  code?: string;
  nftWon?: {
    image?: string;
    content?: {
      links?: { image?: string };
      files?: { uri?: string }[];
      metadata?: { name?: string; attributes?: { trait_type?: string; value?: string | number }[] };
    };
  };
};

export const openPack = async (memo: string, waitMs = 60_000) => {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${config.gachaApi}/api/openPack`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ memo }),
    });
    const body = (await res.json().catch(() => ({}))) as OpenedPack & { error?: string; code?: string };
    if (body.code === "WAITING_FOR_WEBHOOK" || res.status === 404) {
      await sleep(1_000);
      continue;
    }
    if (!res.ok) throw new Error(body.error || "The pack is not open yet.");
    if (body.nft_address) return body;
    await sleep(1_000);
  }
  return null;
};

export const packPaid = async (memo: string) => {
  const body = await gacha<{
    pack?: { status?: string | null; webhook_received?: boolean; transaction_signature?: string | null } | null;
    send?: { insured_value?: number | null; transaction_signature?: string | null } | null;
  }>(`/api/pack/status?memo=${encodeURIComponent(memo)}`);
  const paid = body.pack?.status === "confirmed" || body.pack?.webhook_received === true;
  return {
    paid,
    paySignature: body.pack?.transaction_signature || null,
    insured: body.send?.insured_value ?? null,
    openSignature: body.send?.transaction_signature || null,
  };
};

export const buybackTx = async (player: string, nft: string) =>
  gacha<{ serializedTransaction: string; refundAmount: number; memo?: string }>("/api/buyback", {
    method: "POST",
    body: JSON.stringify({ playerAddress: player, nftAddress: nft }),
  });
