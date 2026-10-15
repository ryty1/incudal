-- AlterTable: bot_promo_codes 增加 cycle_months
-- 需求：优惠券要能指定「对应周期」（月/季度/半年/年），核销时按这个周期检测并续费。
--   1 = 月，3 = 季度，6 = 半年，12 = 年
-- 历史数据默认 1（按月），旧码均已过期，不做回填。

ALTER TABLE "bot_promo_codes" ADD COLUMN "cycle_months" INTEGER NOT NULL DEFAULT 1;
