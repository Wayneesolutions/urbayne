-- Phase 4: pre-recorded audio for voter pages (Punjabi and Hindi first). A person records each approved page; the voter page
-- plays the recording instead of the phone's own voice. A recording is tied to the exact text it was made from: when the text
-- changes, the recording is stale and is not played until it is replaced.

CREATE TABLE audio_clips (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content_item_id uuid NOT NULL UNIQUE REFERENCES content_items(id) ON DELETE CASCADE,
  file_id         uuid NOT NULL REFERENCES stored_files(id),
  body_sha256     text NOT NULL,           -- hash of the page text this was recorded from
  duration_ms     int CHECK (duration_ms IS NULL OR duration_ms > 0),
  recorded_by     text,                    -- the voice artist's name, for credit and for re-recording
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audio_clips ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audio_clips USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON audio_clips TO cs_app;
