Pulls API and the fee and pack worker.

`npm start` migrates, serves the API, and runs the worker every 10 minutes.
Copy `.env.example` to `.env`. Do not commit secrets.

Coins are created on pump.fun paired with CARDS. Creator fees are claimed to the vault, swapped to USDC, and used to open graded packs. A holder of that coin receives the card.
