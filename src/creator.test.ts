import assert from "node:assert/strict";
import test from "node:test";
import { feeClaimPlan } from "./claim-plan.js";
import { deriveCreator } from "./creator.js";

test("derives the same creator for an index", () => {
  const first = deriveCreator("test-seed", 0);
  const again = deriveCreator("test-seed", 0);
  const next = deriveCreator("test-seed", 1);
  assert.equal(first.publicKey.toBase58(), again.publicKey.toBase58());
  assert.notEqual(first.publicKey.toBase58(), next.publicKey.toBase58());
});

test("claims bonding fees before migration and pool fees after", () => {
  assert.deepEqual(feeClaimPlan(false, 5n, 0n), { collectBonding: true, collectPool: false });
  assert.deepEqual(feeClaimPlan(false, 0n, 9n), { collectBonding: false, collectPool: false });
  assert.deepEqual(feeClaimPlan(true, 0n, 9n), { collectBonding: false, collectPool: true });
  assert.deepEqual(feeClaimPlan(true, 4n, 9n), { collectBonding: true, collectPool: true });
  assert.deepEqual(feeClaimPlan(true, 0n, 0n), { collectBonding: false, collectPool: false });
});
