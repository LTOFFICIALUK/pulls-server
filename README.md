Pulls API and the fee and pack worker.

`npm start` migrates, serves the API, and runs the worker every 10 minutes.
Copy `.env.example` to `.env`. Do not commit secrets.

Coins are created on pump.fun paired with CARDS. Creator fees are claimed to the vault, swapped to USDC, and used to open graded packs. A holder of that coin receives the card.

$PULLS is CVxBbgYaGpLxCX8j5eFtaR34WStUFcxDGLQ8EKhPULLS. It is launched from the platform wallet 96kZtx5Vkn6KkXLG4WDUF3EsDAR9CxGzhAKdXEMPULLS. Set PLATFORM_SECRET_KEY so the worker can claim those creator fees into that wallet. They stay there for platform costs. Ten percent of every other coin still tops up $PULLS packs.
