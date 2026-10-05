-- Service tickets send two kinds of SMS in India under registered DLT templates: an acknowledgement and a status update.
ALTER TABLE content_items DROP CONSTRAINT content_items_template_key_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_template_key_check CHECK (template_key IN ('shift_reminder', 'ticket_ack', 'ticket_status'));
