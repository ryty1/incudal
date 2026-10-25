-- 补齐线上库已有、但迁移文件里缺的结构（历史手工加过，没进 migrations）
-- 不补的话新装环境 Prisma 查询会报 P2022: column does not exist

-- 1) 守护强制下线任务表（bot-bridge 的 /guard/enforce 用）
CREATE TABLE IF NOT EXISTS "guard_enforce_jobs" (
    "id"              SERIAL PRIMARY KEY,
    "run_id"          TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'running',
    "total_users"     INTEGER NOT NULL DEFAULT 0,
    "total_instances" INTEGER NOT NULL DEFAULT 0,
    "done_instances"  INTEGER NOT NULL DEFAULT 0,
    "incus_deleted"   INTEGER NOT NULL DEFAULT 0,
    "incus_failed"    INTEGER NOT NULL DEFAULT 0,
    "suspended"       JSONB,
    "unbound"         JSONB,
    "failed"          JSONB,
    "error"           TEXT,
    "created_at"      timestamptz(3) NOT NULL DEFAULT now(),
    "updated_at"      timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "guard_enforce_jobs_run_id_idx"    ON "guard_enforce_jobs" ("run_id");
CREATE INDEX IF NOT EXISTS "guard_enforce_jobs_created_at_idx" ON "guard_enforce_jobs" ("created_at" DESC);

-- 2) 守护日志：run_id / enforced / details
ALTER TABLE "bot_guard_logs" ADD COLUMN IF NOT EXISTS "run_id"   TEXT;
ALTER TABLE "bot_guard_logs" ADD COLUMN IF NOT EXISTS "enforced" JSONB;
ALTER TABLE "bot_guard_logs" ADD COLUMN IF NOT EXISTS "details"  JSONB;

-- 3) 机器人推广码：归属用户名/邮箱
ALTER TABLE "bot_promo_codes" ADD COLUMN IF NOT EXISTS "owner_username" TEXT;
ALTER TABLE "bot_promo_codes" ADD COLUMN IF NOT EXISTS "owner_email"    TEXT;

-- 4) 节点流量控制字段
ALTER TABLE "hosts" ADD COLUMN IF NOT EXISTS "traffic_blocked"      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "hosts" ADD COLUMN IF NOT EXISTS "traffic_limit_gb"     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "hosts" ADD COLUMN IF NOT EXISTS "traffic_report_token" TEXT;
ALTER TABLE "hosts" ADD COLUMN IF NOT EXISTS "traffic_stat_mode"    TEXT NOT NULL DEFAULT '';

-- 5) TG 绑定冷却时间（30 天内不能重复解绑/换绑）
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tg_bind_changed_at" timestamptz(3);
