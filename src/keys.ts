import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

export const vaultKeypair = () => {
  if (!config.vaultSecret) return null;
  return Keypair.fromSecretKey(bs58.decode(config.vaultSecret));
};

export const requireVault = () => {
  const key = vaultKeypair();
  if (!key) throw new Error("The vault is not configured yet.");
  return key;
};

export const platformKeypair = () => {
  if (!config.platformSecret) return null;
  const key = Keypair.fromSecretKey(bs58.decode(config.platformSecret));
  if (config.platformWallet && key.publicKey.toBase58() !== config.platformWallet) {
    throw new Error("The platform key does not match the platform wallet.");
  }
  return key;
};
