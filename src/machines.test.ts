import assert from "node:assert/strict";
import test from "node:test";
import { pickMachine, type Machine } from "./machines.js";

const machines: Machine[] = [
  { code: "closed_10", price: 10, instantBuyback: 90, open: false, listed: true },
  { code: "private_5", price: 5, instantBuyback: 90, open: true, listed: false },
  { code: "pack_25", price: 25, instantBuyback: 85, open: true, listed: true },
  { code: "pack_25b", price: 25, instantBuyback: 93, open: true, listed: true },
  { code: "pack_50", price: 50, instantBuyback: 95, open: true, listed: true },
];

test("picks the cheapest open listed machine, then the stronger buyback", () => {
  assert.equal(pickMachine(machines)?.code, "pack_25b");
  assert.equal(pickMachine([]), null);
});
