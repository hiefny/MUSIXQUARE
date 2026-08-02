-- Forward-only ownership-suspension projection. Existing suspended rows were
-- created solely by the operator endpoint before canonical reasons existed.
ALTER TABLE mxqr_pro_room_registry ADD COLUMN suspension_reason TEXT;

UPDATE mxqr_pro_room_registry
SET suspension_reason = 'operator_suspended'
WHERE status = 'suspended' AND suspension_reason IS NULL;

UPDATE mxqr_pro_room_registry
SET suspension_reason = NULL
WHERE status <> 'suspended' AND suspension_reason IS NOT NULL;

CREATE TRIGGER mxqr_pro_room_registry_suspension_reason_insert_guard
BEFORE INSERT ON mxqr_pro_room_registry
WHEN (
  NEW.status = 'suspended'
  AND (
    NEW.suspension_reason IS NULL
    OR NEW.suspension_reason NOT IN (
      'operator_suspended',
      'owner_account_deleted',
      'ownership_transfer_pending'
    )
  )
) OR (NEW.status <> 'suspended' AND NEW.suspension_reason IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Invalid PRO room suspension reason');
END;

CREATE TRIGGER mxqr_pro_room_registry_suspension_reason_update_guard
BEFORE UPDATE OF status, suspension_reason ON mxqr_pro_room_registry
WHEN (
  NEW.status = 'suspended'
  AND (
    NEW.suspension_reason IS NULL
    OR NEW.suspension_reason NOT IN (
      'operator_suspended',
      'owner_account_deleted',
      'ownership_transfer_pending'
    )
  )
) OR (NEW.status <> 'suspended' AND NEW.suspension_reason IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'Invalid PRO room suspension reason');
END;
