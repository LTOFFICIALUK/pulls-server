import assert from "node:assert/strict";
import test from "node:test";
import { dollarsToRaw, nextPackEtaMs, splitUsdc } from "./split.js";

test("splits a claim 90 and 10", () => {
  assert.deepEqual(splitUsdc(100n), { coin: 90n, pulls: 0n, platform: 10n });
  assert.deepEqual(splitUsdc(1n), { coin: 0n, pulls: 0n, platform: 1n });
  const parts = splitUsdc(123_456_789n);
  assert.equal(parts.coin + parts.pulls + parts.platform, 123_456_789n);
  assert.equal(parts.coin, (123_456_789n * 90n) / 100n);
});

test("turns pack prices into USDC base units", () => {
  assert.equal(dollarsToRaw(25), 25_000_000n);
  assert.equal(dollarsToRaw(50.5), 50_500_000n);
  assert.equal(dollarsToRaw(0), 0n);
});

test("estimates the next pack from balance and pace", () => {
  assert.equal(nextPackEtaMs(50n, 50n, 0), 0);
  assert.equal(nextPackEtaMs(0n, 100n, 0), null);
  assert.equal(nextPackEtaMs(40n, 100n, 2), 30);
});
