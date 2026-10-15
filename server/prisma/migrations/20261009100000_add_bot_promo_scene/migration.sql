-- AlterTable: bot_promo_codes 增加 scene 字段
-- 需求：机器人的「创建实例」和「续费」优惠码必须分开，不能混用。
--   purchase = 只能在面板「创建实例」时核销
--   renew    = 只能在机器人里「续费」核销
-- 历史数据默认 purchase（旧码均已过期，仅保留审计价值，不做回填）。

ALTER TABLE "bot_promo_codes" ADD COLUMN "scene" TEXT NOT NULL DEFAULT 'purchase';

CREATE INDEX "bot_promo_codes_scene_status_idx" ON "bot_promo_codes"("scene", "status");
