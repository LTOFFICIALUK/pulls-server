import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { isSome, keypairIdentity, publicKey, type PublicKey as UmiPublicKey, type Umi } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { dasApi, type DasApiInterface } from "@metaplex-foundation/digital-asset-standard-api";
import { fetchAsset, transfer as coreTransfer } from "@metaplex-foundation/mpl-core";
import { fetchDigitalAsset, TokenStandard, transferV1 } from "@metaplex-foundation/mpl-token-metadata";
import { getAssetWithProof, transfer as bubblegumTransfer } from "@metaplex-foundation/mpl-bubblegum";
import type { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import { gradeLabel, type Trait } from "./grade.js";

type DasAsset = {
  interface?: string;
  content?: {
    links?: { image?: string };
    files?: { uri?: string }[];
    metadata?: { name?: string; attributes?: Trait[] };
  };
  compression?: { compressed?: boolean };
};

const umiFor = (vault: Keypair) =>
  createUmi(config.heliusRpc).use(dasApi()).use(keypairIdentity(fromWeb3JsKeypair(vault))) as Umi & { rpc: DasApiInterface };

const signatureOf = (value: unknown) => {
  if (value instanceof Uint8Array) return bs58.encode(value);
  if (value && typeof value === "object" && "signature" in value) {
    const signature = (value as { signature: Uint8Array }).signature;
    return bs58.encode(signature);
  }
  throw new Error("The card transfer did not return a signature.");
};

export const readCard = async (nft: string) => {
  if (!config.heliusRpc) return null;
  const res = await fetch(config.heliusRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "card", method: "getAsset", params: { id: nft } }),
  });
  const body = (await res.json()) as { result?: DasAsset };
  const asset = body.result;
  if (!asset) return null;
  const attributes = asset.content?.metadata?.attributes || [];
  return {
    name: asset.content?.metadata?.name || "",
    image: asset.content?.links?.image || asset.content?.files?.[0]?.uri || "",
    grade: gradeLabel(attributes),
    attributes,
    compressed: Boolean(asset.compression?.compressed),
    interface: asset.interface || "",
  };
};

export const transferCard = async (vault: Keypair, nft: string, winner: string) => {
  const umi = umiFor(vault);
  const card = await readCard(nft);
  const mint = publicKey(nft);
  const nextOwner = publicKey(winner);
  if (card?.interface === "MplCoreAsset") {
    const asset = await fetchAsset(umi, mint);
    return signatureOf(await coreTransfer(umi, { asset, newOwner: nextOwner }).sendAndConfirm(umi));
  }
  if (card?.compressed) {
    const proof = await getAssetWithProof(umi, mint);
    return signatureOf(
      await bubblegumTransfer(umi, { ...proof, leafOwner: umi.identity, newLeafOwner: nextOwner }).sendAndConfirm(umi),
    );
  }
  const digital = await fetchDigitalAsset(umi, mint).catch(() => null);
  const fromChain = digital?.metadata.tokenStandard;
  const unwrapped = fromChain && isSome(fromChain) ? fromChain.value : null;
  const standard =
    unwrapped === TokenStandard.ProgrammableNonFungible || unwrapped === TokenStandard.NonFungible
      ? unwrapped
      : card?.interface === "ProgrammableNFT"
        ? TokenStandard.ProgrammableNonFungible
        : TokenStandard.NonFungible;
  const programmable = digital?.metadata.programmableConfig;
  const rules: UmiPublicKey | undefined =
    programmable && isSome(programmable) && isSome(programmable.value.ruleSet) ? programmable.value.ruleSet.value : undefined;
  return signatureOf(
    await transferV1(umi, {
      mint,
      authority: umi.identity,
      tokenOwner: umi.identity.publicKey,
      destinationOwner: nextOwner,
      tokenStandard: standard,
      ...(rules ? { authorizationRules: rules } : {}),
    }).sendAndConfirm(umi),
  );
};
