-- Add performance indexes for billing scheduler, cleanup tasks, and common queries
-- These indexes improve query performance for scheduled jobs and frequent read patterns

-- Instance: auto-renew scheduler queries (billing-scheduler)
CREATE INDEX IF NOT EXISTS "instances_auto_renew_expires_at_idx" ON "instances"("auto_renew", "expires_at");

-- Recharge records: expired order cleanup (billing-scheduler)
CREATE INDEX IF NOT EXISTS "recharge_records_status_expired_at_idx" ON "recharge_records"("status", "expired_at");

-- Logs: user timeline queries
CREATE INDEX IF NOT EXISTS "logs_user_id_created_at_idx" ON "logs"("user_id", "created_at" DESC);

-- Inbox messages: periodic cleanup of old messages
CREATE INDEX IF NOT EXISTS "inbox_messages_created_at_idx" ON "inbox_messages"("created_at");

-- Operation verifications: cleanup verified/expired records
CREATE INDEX IF NOT EXISTS "operation_verifications_user_id_verified_idx" ON "operation_verifications"("user_id", "verified");

-- Email verification codes: email history queries
CREATE INDEX IF NOT EXISTS "email_verification_codes_email_created_at_idx" ON "email_verification_codes"("email", "created_at" DESC);

-- Balance logs: order ID lookup for payment reconciliation
CREATE INDEX IF NOT EXISTS "balance_logs_order_id_idx" ON "balance_logs"("order_id");

-- AFF logs: user earnings detail queries (by type + time)
CREATE INDEX IF NOT EXISTS "aff_logs_user_id_type_created_at_idx" ON "aff_logs"("user_id", "type", "created_at" DESC);
