-- P0-6: provider cost per call (USD micro-dollars, as reported by the provider) so calls count toward the spending limit.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS cost_usd_micros bigint;
