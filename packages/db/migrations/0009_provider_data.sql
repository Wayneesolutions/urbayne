-- P0-5: when a campaign's personal data is deleted, the voice provider's own copy of each call (transcript, messages,
-- any recording) is deleted too. This records which calls have been cleaned at the provider, so a failed attempt can be retried.
ALTER TABLE interactions ADD COLUMN provider_data_deleted_at timestamptz;
