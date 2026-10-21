import assert from "node:assert/strict";
import test from "node:test";
import { nextPackAction } from "./packs-state.js";

test("resumes an unpaid quote and never pays it twice", () => {
  assert.equal(nextPackAction({ status: "quoted", ageMs: 1_000, paid: false }), "sign");
  assert.equal(nextPackAction({ status: "signed", ageMs: 1_000, paid: null }), "submit");
  assert.equal(nextPackAction({ status: "signed", ageMs: 120_000, paid: false }), "refund");
  assert.equal(nextPackAction({ status: "submitted", ageMs: 1_000, paid: true }), "open");
  assert.equal(nextPackAction({ status: "submitted", ageMs: 1_000, paid: null }), "open");
  assert.equal(nextPackAction({ status: "opened", ageMs: 1, paid: true }), "transfer");
  assert.equal(nextPackAction({ status: "sent", ageMs: 1, paid: true }), "done");
});
