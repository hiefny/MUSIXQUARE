-- Forward-only key-to-owner-authority incarnation binding. Existing keys are
-- bound to epoch zero; the canonical PRO room rejects them after any owner
-- authority transition that advanced its epoch.
ALTER TABLE mxqr_developer_api_keys
  ADD COLUMN authority_epoch INTEGER NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0);

CREATE TRIGGER trg_mxqr_developer_api_keys_authority_epoch_immutable
BEFORE UPDATE OF authority_epoch ON mxqr_developer_api_keys
WHEN NEW.authority_epoch <> OLD.authority_epoch
BEGIN
  SELECT RAISE(ABORT, 'developer_api_key_authority_epoch_immutable');
END;
