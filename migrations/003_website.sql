ALTER TABLE coins ADD COLUMN IF NOT EXISTS website_url text;
ALTER TABLE launches ADD COLUMN IF NOT EXISTS website_url text;
