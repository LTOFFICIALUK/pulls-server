Pulls API and the fee and pack worker.

`npm start` migrates, serves the API, and runs the worker every 10 minutes.
Copy `.env.example` to `.env`. Do not commit secrets.

Coins are created on pump.fun paired with CARDS. Each coin gets a creator wallet derived from CREATOR_MASTER_SEED and an index stored on the coin. That wallet is the pump creator, so its fees stay separate. The vault pays the claim fee. The coin wallet signs. Claimed CARDS move to the vault, swap to USDC, and split 80 percent to that coin, 10 percent to $PULLS packs, and 10 percent to the platform wallet. A holder of that coin receives the card.

$PULLS is CVxBbgYaGpLxCX8j5eFtaR34WStUFcxDGLQ8EKhPULLS. It launched on Proxima with creator 96kZtx5Vkn6KkXLG4WDUF3EsDAR9CxGzhAKdXEMPULLS. The fee loop skips it. Its packs open when the 10 percent balance covers a pack, and a holder is drawn the same way as every other coin.

Set CREATOR_MASTER_SEED. Do not log or commit it.
