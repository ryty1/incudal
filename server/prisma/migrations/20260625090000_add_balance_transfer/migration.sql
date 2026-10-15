ALTER TYPE "BalanceLogType" ADD VALUE IF NOT EXISTS 'balance_transfer_out';
ALTER TYPE "BalanceLogType" ADD VALUE IF NOT EXISTS 'balance_transfer_in';
ALTER TYPE "BalanceLogType" ADD VALUE IF NOT EXISTS 'balance_transfer_fee';

INSERT INTO "system_configs" ("key", "value", "type", "label", "description", "created_at", "updated_at")
VALUES
  ('balance_transfer_enabled', 'false', 'boolean', '允许余额转账', '开启后，用户可在钱包中向其他用户转账余额', NOW(), NOW()),
  ('balance_transfer_fee', '0', 'number', '余额转账手续费', '用户发起余额转账时额外支付的固定手续费（元/次），0 表示免费', NOW(), NOW())
ON CONFLICT ("key") DO NOTHING;
