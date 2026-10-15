-- AddTable: bot_promo_codes + bot_guard_logs
-- Bot-issued discount codes (redeem points in group -> bot deducts -> issues code -> user applies
-- to renewal) and guard sync audit logs.
-- Distinct from redeem_codes (host resource quota codes). No FK: no Prisma relation declared on purpose.

CREATE TABLE "bot_promo_codes" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "telegram_user_id" TEXT,
    "points_cost" INTEGER NOT NULL DEFAULT 0,
    "item_name" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source_chat_id" BIGINT,
    "reason" TEXT,
    "used_at" TIMESTAMP(3),
    "used_instance_id" INTEGER,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_promo_codes_code_key" ON "bot_promo_codes"("code");

-- CreateIndex
CREATE INDEX "bot_promo_codes_user_id_status_idx" ON "bot_promo_codes"("user_id", "status");

-- CreateIndex
CREATE INDEX "bot_promo_codes_status_expires_at_idx" ON "bot_promo_codes"("status", "expires_at");

-- CreateIndex
CREATE INDEX "bot_promo_codes_created_at_idx" ON "bot_promo_codes"("created_at" DESC);

-- AddTable: bot_guard_logs
CREATE TABLE "bot_guard_logs" (
    "id" SERIAL NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chat_id" BIGINT,
    "source" TEXT NOT NULL DEFAULT 'bot',
    "total" INTEGER NOT NULL DEFAULT 0,
    "in_group" INTEGER NOT NULL DEFAULT 0,
    "left_group" INTEGER NOT NULL DEFAULT 0,
    "unbound" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_guard_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_guard_logs_created_at_idx" ON "bot_guard_logs"("created_at" DESC);
