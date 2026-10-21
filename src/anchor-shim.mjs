import { createRequire } from "node:module";
import BN from "bn.js";

const require = createRequire(import.meta.url);
const anchor = require("@coral-xyz/anchor");

export { BN };
export const AnchorProvider = anchor.AnchorProvider;
export const Program = anchor.Program;
export const Wallet = anchor.Wallet;
export const web3 = anchor.web3;
export default anchor;
