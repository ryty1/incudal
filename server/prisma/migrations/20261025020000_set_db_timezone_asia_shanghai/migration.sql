-- 数据库默认时区设为 Asia/Shanghai（仅影响会话展示，不影响已存的绝对时刻）
-- 应用侧通过 DATABASE_URL 的 options 强制 UTC 连接：
--   Prisma 解析带 +08 偏移的时间串会丢时区，直接读会整体差 8 小时
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Shanghai');
END $$;
