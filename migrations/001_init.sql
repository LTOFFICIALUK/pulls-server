CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coins (
  mint text PRIMARY KEY,
  name text NOT NULL,
  symbol text NOT NULL,
  description text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  metadata_uri text NOT NULL DEFAULT '',
  x_url text,
  launcher text NOT NULL,
  creator text NOT NULL,
  source text NOT NULL DEFAULT 'pulls',
  launch_signature text,
  dev_buy_sol numeric NOT NULL DEFAULT 0,
  cards_pending bigint NOT NULL DEFAULT 0,
  cards_claimed bigint NOT NULL DEFAULT 0,
  pack_balance_usdc bigint NOT NULL DEFAULT 0,
  holder_count integer NOT NULL DEFAULT 0,
  holders_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS treasury (
  id integer PRIMARY KEY CHECK (id = 1),
  pulls_owed_usdc bigint NOT NULL DEFAULT 0,
  platform_owed_usdc bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO treasury (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY,
  content_type text NOT NULL,
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS launches (
  id text PRIMARY KEY,
  wallet text NOT NULL,
  mint text NOT NULL UNIQUE,
  name text NOT NULL,
  symbol text NOT NULL,
  description text NOT NULL DEFAULT '',
  x_url text,
  image_id text NOT NULL,
  metadata_uri text NOT NULL,
  dev_buy_sol numeric NOT NULL DEFAULT 0,
  transactions jsonb NOT NULL,
  status text NOT NULL DEFAULT 'built',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fee_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint text NOT NULL REFERENCES coins (mint),
  cards_raw bigint NOT NULL,
  usdc_raw bigint NOT NULL DEFAULT 0,
  signature text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_mint text NOT NULL,
  dest_mint text,
  kind text NOT NULL,
  usdc_raw bigint NOT NULL,
  signature text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_source_idx ON ledger (source_mint, created_at DESC);

CREATE TABLE IF NOT EXISTS packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memo text NOT NULL UNIQUE,
  mint text NOT NULL REFERENCES coins (mint),
  pack_type text NOT NULL,
  price_usdc bigint NOT NULL,
  instant_buyback integer NOT NULL DEFAULT 0,
  debited boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  unsigned_tx text,
  signed_tx text,
  pay_signature text,
  open_signature text,
  nft_address text,
  nft_name text,
  nft_image text,
  grade text,
  rarity text,
  insured_value_usd numeric,
  roll text,
  seed text,
  snapshot jsonb,
  excluded jsonb,
  winner text,
  transfer_signature text,
  choice text,
  choice_at timestamptz,
  buyback_signature text,
  buyback_amount bigint,
  opened_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS packs_mint_idx ON packs (mint, created_at DESC);
CREATE INDEX IF NOT EXISTS packs_status_idx ON packs (status);
