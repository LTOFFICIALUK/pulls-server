export const feeClaimPlan = (migrated: boolean, pumpRaw: bigint, ammRaw: bigint) => ({
  collectBonding: pumpRaw > 0n,
  collectPool: migrated && ammRaw > 0n,
});
