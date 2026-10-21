import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

let connection: Connection | null = null;

export const rpc = () => {
  if (!config.heliusRpc) throw new Error("HELIUS_RPC is required.");
  if (!connection) connection = new Connection(config.heliusRpc, "confirmed");
  return connection;
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const encodeTx = (tx: Transaction) =>
  Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");

export const messageOf = (raw: Buffer) => {
  try {
    return Buffer.from(Transaction.from(raw).serializeMessage());
  } catch {
    return Buffer.from(VersionedTransaction.deserialize(raw).message.serialize());
  }
};

export const messagesMatch = (left: string, right: string) => messageOf(Buffer.from(left, "base64")).equals(messageOf(Buffer.from(right, "base64")));

const signatureOf = (raw: Buffer) => {
  try {
    const tx = Transaction.from(raw);
    if (!tx.signature) throw new Error("The transaction has no signature.");
    return bs58.encode(tx.signature);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no signature")) throw err;
    const tx = VersionedTransaction.deserialize(raw);
    const first = tx.signatures[0];
    if (!first || first.every((byte) => byte === 0)) throw new Error("The transaction has no signature.");
    return bs58.encode(first);
  }
};

export const sendSigned = async (base64: string) => {
  const raw = Buffer.from(base64, "base64");
  const signature = signatureOf(raw);
  const connection = rpc();
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  const confirmed = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  if (confirmed.value.err) throw new Error("The network rejected the transaction.");
  return signature;
};

export const signAndSend = async (tx: Transaction, signers: Keypair[]) => {
  const connection = rpc();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]?.publicKey;
  tx.sign(...signers);
  const signature = await sendSigned(Buffer.from(tx.serialize()).toString("base64"));
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed").catch(() => undefined);
  return signature;
};

export const pubkey = (value: string, label: string) => {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a Solana address.`);
  }
};
