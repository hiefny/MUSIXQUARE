-- Forward-only launch cutover: the generation-aware reverse index is now the
-- sole account-to-PRO-room authority edge.

DROP INDEX IF EXISTS idx_mxqr_account_pro_rooms_account;
DROP TABLE IF EXISTS mxqr_account_pro_rooms;
