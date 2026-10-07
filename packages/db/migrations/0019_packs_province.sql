-- Phase 5: election packages and provincial rules.
ALTER TABLE tenants ADD COLUMN province text CHECK (province IS NULL OR province ~ '^[A-Z]{2}$');   -- Canadian province (for example MB), when provincial rules apply
ALTER TABLE tenants ADD COLUMN pack_id text;                                 -- the election package applied to this campaign, if any
ALTER TABLE tenants ADD COLUMN pack_applied_at timestamptz;
ALTER TABLE tenants ADD COLUMN pack_checks jsonb NOT NULL DEFAULT '{}';      -- onboarding checklist items ticked by hand: { itemId: { by, at } }
