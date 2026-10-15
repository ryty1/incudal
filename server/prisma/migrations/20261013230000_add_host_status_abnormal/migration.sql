-- AlterEnum: HostStatus 增加 abnormal（节点异常）
--
-- 需求：节点在线检测要区分两种情况——
--   · TCP 端口通，但 Incus API 不响应  → 异常 = abnormal
--   · TCP 端口也不通                    → 离线 = offline
-- 之前的检测把两者都记成 offline，用户无法分辨「网络断了」还是「节点异常」。
--
-- 用 IF NOT EXISTS 保证可重复执行。
ALTER TYPE "HostStatus" ADD VALUE IF NOT EXISTS 'abnormal';
