-- 节点延迟探针采样表（广州/上海 TCP 探测结果）
CREATE TABLE IF NOT EXISTS "host_latency_samples" (
    "id"          SERIAL PRIMARY KEY,
    "host_id"     INTEGER NOT NULL REFERENCES "hosts"("id") ON DELETE CASCADE,
    "probe"       TEXT NOT NULL,
    "latency_ms"  DOUBLE PRECISION,
    "loss_pct"    DOUBLE PRECISION NOT NULL DEFAULT 100,
    "samples"     INTEGER NOT NULL DEFAULT 0,
    "measured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "host_latency_samples_host_probe_time_idx"
    ON "host_latency_samples" ("host_id", "probe", "measured_at" DESC);
