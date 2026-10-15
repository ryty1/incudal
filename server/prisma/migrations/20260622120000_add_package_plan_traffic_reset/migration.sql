ALTER TABLE "package_plans"
  ADD COLUMN "traffic_reset_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "traffic_reset_price" DECIMAL(10, 2) NOT NULL DEFAULT 0;
