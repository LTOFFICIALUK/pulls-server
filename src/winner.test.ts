import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import test from "node:test";
import { eligibleHolders, pickWinner, seedFromSignature, type Holder } from "./winner.js";

const holders: Holder[] = [
  { wallet: "B", amount: 1_000n },
  { wallet: "A", amount: 3_000n },
  { wallet: "C", amount: 50n },
];

test("drops dust, excluded wallets, and sorts by address", () => {
  const supply = 1_000_000n;
  const eligible = eligibleHolders(holders, supply, new Set(["B"]));
  assert.deepEqual(
    eligible.map((holder) => holder.wallet),
    ["A"],
  );
});

test("picks the same winner for the same signature", () => {
  const signature = Keypair.generate().publicKey.toBase58();
  const seed = seedFromSignature(signature);
  const pool = eligibleHolders(
    [
      { wallet: "A", amount: 5_000n },
      { wallet: "B", amount: 5_000n },
    ],
    1_000_000n,
    new Set(),
  );
  assert.equal(pickWinner(pool, seed), pickWinner(pool, seed));
  assert.ok(pool.some((holder) => holder.wallet === pickWinner(pool, seed)));
});

test("a zero seed lands on the first wallet", () => {
  const pool = [
    { wallet: "A", amount: 10n },
    { wallet: "B", amount: 10n },
  ];
  assert.equal(pickWinner(pool, Buffer.alloc(32)), "A");
});
