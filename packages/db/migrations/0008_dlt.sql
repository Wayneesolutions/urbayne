-- P0-4: India DLT template registration lifecycle for SMS templates.
-- not_registered -> submitted (text pasted into the DLT portal) -> registered (template id + sender header recorded) | rejected.
ALTER TABLE content_items ADD COLUMN dlt_status text NOT NULL DEFAULT 'not_registered'
  CHECK (dlt_status IN ('not_registered', 'submitted', 'registered', 'rejected'));
ALTER TABLE content_items ADD COLUMN dlt_header text;                 -- registered 6-letter sender header
ALTER TABLE content_items ADD COLUMN dlt_submitted_at timestamptz;
ALTER TABLE content_items ADD COLUMN dlt_rejection_reason text;
-- Which message the platform sends with this template. Reminders need one registered template per campaign.
ALTER TABLE content_items ADD COLUMN template_key text CHECK (template_key IN ('shift_reminder'));
CREATE UNIQUE INDEX content_items_template_key ON content_items (tenant_id, template_key) WHERE template_key IS NOT NULL;

UPDATE content_items SET dlt_status = 'registered' WHERE dlt_template_id IS NOT NULL;
