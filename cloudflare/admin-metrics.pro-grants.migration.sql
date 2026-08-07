-- Generic PRO entitlement control plane. Campaigns are acquisition sources,
-- never room types: the canonical room continues to be identified only by
-- (room_code, room_generation). Voucher plaintext is deliberately absent.
-- The App Worker stores only a keyed HMAC-SHA256 base64url digest.

CREATE TABLE IF NOT EXISTS mxqr_pro_grant_campaigns (
  campaign_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(campaign_id) = 31
    AND substr(campaign_id, 1, 9) = 'campaign_'
    AND campaign_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  slug TEXT NOT NULL UNIQUE CHECK (
    length(slug) BETWEEN 1 AND 64
    AND slug GLOB '[a-z0-9]*'
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND substr(slug, -1) GLOB '[a-z0-9]'
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'ended', 'revoked')),
  starts_at INTEGER CHECK (starts_at IS NULL OR starts_at >= 0),
  ends_at INTEGER CHECK (ends_at IS NULL OR ends_at >= 0),
  per_account_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_account_limit BETWEEN 1 AND 10),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);

-- An operation row is inserted in the same D1 batch as all voucher rows.
-- request_digest is derived from the ordered roomCode + keyed-code-digest set;
-- it permits an exact replay after response loss without retaining plaintext.
CREATE TABLE IF NOT EXISTS mxqr_pro_grant_voucher_batches (
  campaign_id TEXT NOT NULL REFERENCES mxqr_pro_grant_campaigns(campaign_id),
  request_id TEXT NOT NULL CHECK (
    length(request_id) = 28
    AND substr(request_id, 1, 6) = 'batch_'
    AND request_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 43
    AND request_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('committed', 'revoked')),
  voucher_count INTEGER NOT NULL CHECK (voucher_count BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (campaign_id, request_id)
);

CREATE TABLE IF NOT EXISTS mxqr_pro_grant_vouchers (
  voucher_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(voucher_id) = 30
    AND substr(voucher_id, 1, 8) = 'voucher_'
    AND voucher_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  campaign_id TEXT NOT NULL REFERENCES mxqr_pro_grant_campaigns(campaign_id),
  batch_request_id TEXT NOT NULL CHECK (
    length(batch_request_id) = 28
    AND substr(batch_request_id, 1, 6) = 'batch_'
    AND batch_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  code_digest TEXT NOT NULL UNIQUE CHECK (
    length(code_digest) = 43
    AND code_digest NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  room_code TEXT NOT NULL CHECK (
    length(room_code) = 6
    AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'
  ),
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('available', 'redeemed', 'revoked')),
  redeemed_account_id TEXT CHECK (
    redeemed_account_id IS NULL
    OR (
      length(redeemed_account_id) = 27
      AND substr(redeemed_account_id, 1, 5) = 'acct_'
      AND redeemed_account_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  redeemed_at INTEGER CHECK (redeemed_at IS NULL OR redeemed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (room_code, room_generation),
  FOREIGN KEY (campaign_id, batch_request_id)
    REFERENCES mxqr_pro_grant_voucher_batches(campaign_id, request_id),
  CHECK (
    (status = 'redeemed' AND redeemed_account_id IS NOT NULL AND redeemed_at IS NOT NULL)
    OR (status <> 'redeemed' AND redeemed_account_id IS NULL AND redeemed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grant_vouchers_campaign_status
ON mxqr_pro_grant_vouchers(campaign_id, status, room_code, room_generation);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grant_vouchers_batch
ON mxqr_pro_grant_vouchers(campaign_id, batch_request_id, room_code);

-- Cross-D1 account deletion fence. Account Auth writes this append-only row
-- before/with orphaning the grant projection. Voucher redemption predicates
-- on its absence, so the grant D1 serialization point remains fail-closed
-- even when account deletion races a different Worker isolate.
CREATE TABLE IF NOT EXISTS mxqr_pro_grant_account_fences (
  account_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(account_id) = 27
    AND substr(account_id, 1, 5) = 'acct_'
    AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  reason TEXT NOT NULL CHECK (reason = 'account_deleted'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE IF NOT EXISTS mxqr_pro_grants (
  grant_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(grant_id) = 28
    AND substr(grant_id, 1, 6) = 'grant_'
    AND grant_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  product_code TEXT NOT NULL CHECK (product_code = 'pro_room'),
  plan_code TEXT NOT NULL CHECK (
    length(plan_code) BETWEEN 3 AND 80
    AND plan_code GLOB '[a-z0-9]*'
    AND plan_code NOT GLOB '*[^a-z0-9_:-]*'
  ),
  account_id TEXT NOT NULL CHECK (
    length(account_id) = 27
    AND substr(account_id, 1, 5) = 'acct_'
    AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  source_type TEXT NOT NULL CHECK (source_type IN ('campaign', 'purchase', 'manual', 'legacy')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (
    status IN ('pending_activation', 'active', 'suspended', 'orphaned', 'revoked')
  ),
  valid_from INTEGER NOT NULL CHECK (valid_from >= 0),
  valid_until INTEGER CHECK (valid_until IS NULL OR valid_until > valid_from),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (source_type, source_ref, account_id)
);

-- Product-wide policy: one current PRO entitlement per account, independent
-- of whether it originated from a campaign, a purchase, or an operator grant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_pro_grants_one_current_pro_per_account
ON mxqr_pro_grants(account_id, product_code)
WHERE product_code = 'pro_room'
  AND status IN ('pending_activation', 'active', 'suspended');

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grants_validity_status
ON mxqr_pro_grants(status, valid_until, valid_from, account_id);

-- Allocation is intentionally separate from entitlement. A future paid grant
-- may exist before inventory is assigned, and replacing/decommissioning a room
-- never rewrites the durable acquisition record.
CREATE TABLE IF NOT EXISTS mxqr_pro_grant_allocations (
  allocation_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(allocation_id) = 33
    AND substr(allocation_id, 1, 11) = 'allocation_'
    AND allocation_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  grant_id TEXT NOT NULL UNIQUE REFERENCES mxqr_pro_grants(grant_id),
  room_code TEXT NOT NULL CHECK (
    length(room_code) = 6
    AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'
  ),
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'active', 'suspended', 'orphaned', 'revoked')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (room_code, room_generation)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grant_allocations_room_status
ON mxqr_pro_grant_allocations(room_code, room_generation, status);

-- Product-wide serialization point for every route that can create or move a
-- PRO owner. Grant rows remain the acquisition ledger, while this table also
-- covers legacy activation and ownership transfer paths that live in other D1
-- databases. Transfer-source rows keep the source account occupied while
-- leaving the room index available for the target reservation in the batch.
CREATE TABLE IF NOT EXISTS mxqr_pro_account_entitlements (
  entitlement_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL CHECK (
    length(account_id) = 27
    AND substr(account_id, 1, 5) = 'acct_'
    AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  room_code TEXT NOT NULL CHECK (
    length(room_code) = 6
    AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]'
  ),
  room_generation INTEGER NOT NULL CHECK (room_generation >= 0),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('grant', 'legacy_activation', 'owner_transfer')
  ),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 128),
  transfer_request_id TEXT CHECK (
    transfer_request_id IS NULL
    OR (
      length(transfer_request_id) BETWEEN 16 AND 64
      AND transfer_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'reserved',
      'active',
      'suspended',
      'transfer_source_reserved',
      'transfer_source_active',
      'transfer_source_suspended',
      'transfer_source_orphaned',
      'transfer_target_pending',
      'transferred',
      'orphaned',
      'revoked'
    )
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (source_kind, source_ref),
  CHECK (
    status NOT IN (
      'transfer_source_reserved',
      'transfer_source_active',
      'transfer_source_suspended',
      'transfer_source_orphaned',
      'transfer_target_pending',
      'transferred'
    )
    OR transfer_request_id IS NOT NULL
  ),
  CHECK (source_kind <> 'owner_transfer' OR transfer_request_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_pro_account_entitlements_one_current_account
ON mxqr_pro_account_entitlements(account_id)
WHERE status IN (
  'reserved',
  'active',
  'suspended',
  'transfer_source_reserved',
  'transfer_source_active',
  'transfer_source_suspended'
);

-- Orphaning releases the deleted account but deliberately keeps its exact
-- room incarnation unavailable until an explicit room lifecycle operation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mxqr_pro_account_entitlements_one_reserved_room
ON mxqr_pro_account_entitlements(room_code, room_generation)
WHERE status IN ('reserved', 'active', 'suspended', 'orphaned');

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_account_entitlements_room_status
ON mxqr_pro_account_entitlements(room_code, room_generation, status);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_account_entitlements_transfer_request
ON mxqr_pro_account_entitlements(transfer_request_id, status)
WHERE transfer_request_id IS NOT NULL;

-- Upgrade existing grant-backed allocations into the central serializer. New
-- voucher redemptions insert this row before mutating their voucher.
INSERT OR IGNORE INTO mxqr_pro_account_entitlements (
  account_id,
  room_code,
  room_generation,
  source_kind,
  source_ref,
  transfer_request_id,
  status,
  created_at,
  updated_at
)
SELECT grant.account_id,
       allocation.room_code,
       allocation.room_generation,
       'grant',
       grant.grant_id,
       NULL,
       CASE grant.status
         WHEN 'pending_activation' THEN 'reserved'
         WHEN 'active' THEN 'active'
         WHEN 'suspended' THEN 'suspended'
         WHEN 'orphaned' THEN 'orphaned'
         ELSE 'revoked'
       END,
       grant.created_at,
       MAX(grant.updated_at, allocation.updated_at)
  FROM mxqr_pro_grants grant
  JOIN mxqr_pro_grant_allocations allocation ON allocation.grant_id = grant.grant_id;

CREATE TABLE IF NOT EXISTS mxqr_pro_grant_redemptions (
  redemption_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(redemption_id) = 33
    AND substr(redemption_id, 1, 11) = 'redemption_'
    AND redemption_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  campaign_id TEXT NOT NULL REFERENCES mxqr_pro_grant_campaigns(campaign_id),
  voucher_id TEXT NOT NULL UNIQUE REFERENCES mxqr_pro_grant_vouchers(voucher_id),
  grant_id TEXT NOT NULL UNIQUE REFERENCES mxqr_pro_grants(grant_id),
  account_id TEXT NOT NULL CHECK (
    length(account_id) = 27
    AND substr(account_id, 1, 5) = 'acct_'
    AND account_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('redeemed', 'fulfilled', 'orphaned', 'revoked')),
  claim_generation INTEGER CHECK (claim_generation IS NULL OR claim_generation >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grant_redemptions_account_campaign
ON mxqr_pro_grant_redemptions(account_id, campaign_id, status, created_at);

-- Identifier-only append-only audit trail. Raw voucher codes, their digests,
-- emails, Access assertions, cookies, PINs and activation claims are forbidden.
CREATE TABLE IF NOT EXISTS mxqr_pro_grant_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 8 AND 120),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 3 AND 80),
  result TEXT NOT NULL CHECK (length(result) BETWEEN 2 AND 80),
  campaign_id TEXT,
  voucher_id TEXT,
  grant_id TEXT,
  allocation_id TEXT,
  redemption_id TEXT,
  room_code TEXT CHECK (
    room_code IS NULL
    OR (length(room_code) = 6 AND room_code GLOB '0[0-9][0-9][0-9][0-9][0-9]')
  ),
  room_generation INTEGER CHECK (room_generation IS NULL OR room_generation >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK ((room_code IS NULL) = (room_generation IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_mxqr_pro_grant_audit_campaign_created
ON mxqr_pro_grant_audit(campaign_id, created_at);

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_campaigns_no_delete
BEFORE DELETE ON mxqr_pro_grant_campaigns
BEGIN
  SELECT RAISE(ABORT, 'PRO grant campaigns are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_voucher_batches_no_delete
BEFORE DELETE ON mxqr_pro_grant_voucher_batches
BEGIN
  SELECT RAISE(ABORT, 'PRO grant voucher batches are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_voucher_material_immutable
BEFORE UPDATE OF campaign_id, batch_request_id, code_digest, room_code, room_generation
ON mxqr_pro_grant_vouchers
WHEN NEW.campaign_id <> OLD.campaign_id
  OR NEW.batch_request_id <> OLD.batch_request_id
  OR NEW.code_digest <> OLD.code_digest
  OR NEW.room_code <> OLD.room_code
  OR NEW.room_generation <> OLD.room_generation
BEGIN
  SELECT RAISE(ABORT, 'PRO grant voucher material is immutable');
END;

-- Close the preflight/apply race inside the D1 transaction. If a room is
-- activated, suspended, decommissioned, or advances generation after the
-- Worker preflight, this trigger aborts the whole voucher batch instead of
-- allowing a committed operation row with a partial set of vouchers.
CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_voucher_registry_guard
BEFORE INSERT ON mxqr_pro_grant_vouchers
WHEN NOT EXISTS (
  SELECT 1
  FROM mxqr_pro_room_registry registry
  WHERE registry.room_code = NEW.room_code
    AND registry.room_generation = NEW.room_generation
    AND registry.status = 'registered'
    AND registry.activation_state = 'unactivated'
)
OR EXISTS (
  SELECT 1
  FROM mxqr_pro_account_entitlements entitlement
  WHERE entitlement.room_code = NEW.room_code
    AND entitlement.room_generation = NEW.room_generation
    AND entitlement.status IN (
      'reserved',
      'active',
      'suspended',
      'orphaned',
      'transfer_source_reserved',
      'transfer_source_active',
      'transfer_source_suspended',
      'transfer_source_orphaned',
      'transfer_target_pending'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'PRO grant voucher room is unavailable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_vouchers_no_delete
BEFORE DELETE ON mxqr_pro_grant_vouchers
BEGIN
  SELECT RAISE(ABORT, 'PRO grant vouchers are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grants_no_delete
BEFORE DELETE ON mxqr_pro_grants
BEGIN
  SELECT RAISE(ABORT, 'PRO grants are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_account_fences_no_update
BEFORE UPDATE ON mxqr_pro_grant_account_fences
BEGIN
  SELECT RAISE(ABORT, 'PRO grant account fences are append-only');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_account_fences_no_delete
BEFORE DELETE ON mxqr_pro_grant_account_fences
BEGIN
  SELECT RAISE(ABORT, 'PRO grant account fences are append-only');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_allocations_no_delete
BEFORE DELETE ON mxqr_pro_grant_allocations
BEGIN
  SELECT RAISE(ABORT, 'PRO grant allocations are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_redemptions_no_delete
BEFORE DELETE ON mxqr_pro_grant_redemptions
BEGIN
  SELECT RAISE(ABORT, 'PRO grant redemptions are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_account_entitlements_material_immutable
BEFORE UPDATE OF account_id, room_code, room_generation, source_kind, source_ref, created_at
ON mxqr_pro_account_entitlements
WHEN NEW.account_id <> OLD.account_id
  OR NEW.room_code <> OLD.room_code
  OR NEW.room_generation <> OLD.room_generation
  OR NEW.source_kind <> OLD.source_kind
  OR NEW.source_ref <> OLD.source_ref
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'PRO account entitlement material is immutable');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_account_entitlements_no_delete
BEFORE DELETE ON mxqr_pro_account_entitlements
BEGIN
  SELECT RAISE(ABORT, 'PRO account entitlements are retained');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_audit_no_update
BEFORE UPDATE ON mxqr_pro_grant_audit
BEGIN
  SELECT RAISE(ABORT, 'PRO grant audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS mxqr_pro_grant_audit_no_delete
BEFORE DELETE ON mxqr_pro_grant_audit
BEGIN
  SELECT RAISE(ABORT, 'PRO grant audit is append-only');
END;
