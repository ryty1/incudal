-- 券绑定「套餐 + 节点」：
-- 原实现核销时只按 item_name 与套餐名做模糊匹配，节点完全没校验，
-- 导致「券说好是 A 套餐 A 节点」但能被用到同套餐其它节点、甚至名字相近的套餐上。
-- 新增两列后，核销时做精确比对：
--   · package_id：券指定套餐，必须与实例所属套餐一致
--   · host_id   ：券指定节点，必须与实例所在节点一致，且该节点状态为 online
-- 均可空：老券没有这两个值，保持向后兼容（为空时跳过对应校验）。
ALTER TABLE "bot_promo_codes" ADD COLUMN IF NOT EXISTS "package_id" INTEGER;
ALTER TABLE "bot_promo_codes" ADD COLUMN IF NOT EXISTS "host_id" INTEGER;
