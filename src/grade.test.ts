import assert from "node:assert/strict";
import test from "node:test";
import { gradeLabel } from "./grade.js";

test("reads a grader and a grade from card attributes", () => {
  assert.equal(
    gradeLabel([
      { trait_type: "Grader", value: "PSA" },
      { trait_type: "Grade", value: "10" },
    ]),
    "PSA 10",
  );
  assert.equal(gradeLabel([{ trait_type: "Set", value: "PSA 9" }]), "PSA 9");
  assert.equal(gradeLabel([], "Rare"), "Rare card");
  assert.equal(gradeLabel([]), "Graded card");
});
