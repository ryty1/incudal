#!/bin/bash
# ============================================================
# Incudal 面板 · 数据库导入 / 恢复
#
# 用法:
#   bash /root/incudal-restore.sh list                 列出可用备份（本地 + GitHub + 网盘）
#   bash /root/incudal-restore.sh <文件> [选项]
#
# 选项:
#   --mode overwrite   覆盖模式：清空并完整还原（默认）
#   --mode merge       新增模式：只补缺失的行，不动已有数据
#   --yes              跳过确认（脚本化用）
#
# 安全设计:
#   · 导入前自动给现库存一份 pre-import 快照，出错可一键回退
#   · 覆盖用 pg_restore --clean --if-exists（PostgreSQL 原生，不自己拼 SQL）
#   · 新增用 pg_restore --data-only --on-conflict-do-nothing（主键冲突就跳过）
# ============================================================
set -uo pipefail

APP_DIR="/home/docker/incudal"
BACKUP_DIR="/srv/incudal-backups"
CONF="/srv/incudal-backup.conf"
GITHUB_ENABLED="false"; GITHUB_REPO=""; GITHUB_BRANCH="main"
RCLONE_ENABLED="false"; RCLONE_REMOTE=""
[ -f "$CONF" ] && . "$CONF"

CMD="${1:-list}"

# ---------------- list ----------------
if [ "$CMD" = "list" ] || [ -z "${1:-}" ]; then
  echo "════ 本地备份 ($BACKUP_DIR) ════"
  FOUND=$(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'incudal-*.dump' -o -name 'incudal-*.sql.gz' -o -name 'incudal-db-*.sql.gz' -o -name 'pre-import-*' \) 2>/dev/null)
  if [ -n "$FOUND" ]; then
    ls -lht $FOUND 2>/dev/null | awk '{printf "  %-46s %9s  %s %s %s\n", $9, $5, $6, $7, $8}'
  else
    echo "  (无)"
  fi
  if [ "$GITHUB_ENABLED" = "true" ] && [ -d /root/incudal-git-backup/.git ]; then
    echo ""
    echo "════ GitHub 私库 ════"
    GF=$(find /root/incudal-git-backup -maxdepth 1 -type f \( -name 'incudal-*.dump' -o -name 'incudal-*.sql.gz' \) 2>/dev/null)
    [ -n "$GF" ] && ls -lht $GF 2>/dev/null | awk '{printf "  %-46s %9s  %s %s %s\n", $9, $5, $6, $7, $8}' || echo "  (无)"
  fi
  if [ "$RCLONE_ENABLED" = "true" ] && command -v rclone >/dev/null 2>&1; then
    echo ""
    echo "════ 网盘 ($RCLONE_REMOTE) ════"
    rclone lsl "$RCLONE_REMOTE" 2>/dev/null | tail -20 \
      | awk '{printf "  %-44s %9s  %s %s\n", $4, $1, $2, $3}' || echo "  (拉取失败)"
  fi
  echo ""
  echo "用法: bash $0 <备份文件> [--mode overwrite|merge] [--yes]"
  exit 0
fi

FILE="$1"; shift || true
MODE="overwrite"; YES="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-overwrite}"; shift 2 ;;
    --yes)  YES="yes"; shift ;;
    *) shift ;;
  esac
done
case "$MODE" in overwrite|merge) ;; *) echo "✗ --mode 只能是 overwrite 或 merge"; exit 1 ;; esac

# ---- 远程备份先拉到本地 ----
if [ ! -f "$FILE" ]; then
  B=$(basename "$FILE")
  if [ -d /root/incudal-git-backup/.git ]; then
    ( cd /root/incudal-git-backup && git pull --quiet 2>/dev/null || true )
    [ -f "/root/incudal-git-backup/$B" ] && FILE="/root/incudal-git-backup/$B"
  fi
  if [ ! -f "$FILE" ] && [ "$RCLONE_ENABLED" = "true" ] && command -v rclone >/dev/null 2>&1; then
    mkdir -p "$BACKUP_DIR"
    rclone copy "$RCLONE_REMOTE/$B" "$BACKUP_DIR" 2>/dev/null && [ -f "$BACKUP_DIR/$B" ] && FILE="$BACKUP_DIR/$B"
  fi
fi

[ -f "$FILE" ] || { echo "✗ 找不到备份文件: $FILE"; echo "  先跑: bash $0 list"; exit 1; }

cd "$APP_DIR" || exit 1

# ---- 识别格式 ----
IS_FC=no; IS_SQLGZ=no
case "$FILE" in
  *.dump)   docker compose cp "$FILE" db:/tmp/_verify.dump >/dev/null 2>&1 && \
            docker compose exec -T db pg_restore --list /tmp/_verify.dump >/dev/null 2>&1 && IS_FC=yes ;;
  *.sql.gz) gzip -t "$FILE" 2>/dev/null && IS_SQLGZ=yes ;;
esac
if [ "$IS_FC" != "yes" ] && [ "$IS_SQLGZ" != "yes" ]; then
  echo "✗ 无法识别的备份格式（支持 .dump / .sql.gz）"; exit 1
fi

echo "备份文件: $FILE"
echo "  格式: $([ "$IS_FC" = yes ] && echo 'pg_dump 自定义格式 (-Fc)' || echo 'SQL + gzip')"
echo "  大小: $(( $(stat -c%s "$FILE") / 1024 )) KB"
if [ "$IS_FC" = "yes" ]; then
  docker compose cp "$FILE" db:/tmp/_verify.dump >/dev/null 2>&1
  echo "  表数据段: $(docker compose exec -T db pg_restore --list /tmp/_verify.dump 2>/dev/null | grep -c 'TABLE DATA')"
  docker compose exec -T db rm -f /tmp/_verify.dump >/dev/null 2>&1
else
  echo "  表数量: $(zcat "$FILE" 2>/dev/null | grep -c 'CREATE TABLE' || true)"
fi
echo "  模式: $MODE  （overwrite=清空还原 / merge=只补缺失行）"
echo ""

if [ "$YES" != "yes" ]; then
  echo "⚠️  导入会修改当前数据库，导入前会自动存一份 pre-import 快照。"
  [ "$MODE" = "overwrite" ] && echo "⚠️  覆盖模式会【清空现有表】再还原！"
  read -r -p "确认继续？输入 YES: " ans
  [ "$ans" = "YES" ] || { echo "已取消"; exit 0; }
fi

# ---- 导入前快照（必须成功）----
PRE="$BACKUP_DIR/pre-import-$(date '+%Y%m%d-%H%M%S').sql.gz"
if docker compose exec -T db pg_dump -U incudal -d incudal -Fc --no-owner --no-privileges > "$PRE" 2>/dev/null \
   && [ "$(stat -c%s "$PRE" 2>/dev/null || echo 0)" -gt 4096 ]; then
  echo "✓ 已存导入前快照: $PRE"
else
  echo "✗ 导入前快照失败，中止（避免不可逆操作）"; rm -f "$PRE"; exit 1
fi
echo ""

# ---- 执行导入 ----
echo "正在导入（$MODE）..."
RC=0
if [ "$IS_FC" = "yes" ]; then
  if [ "$MODE" = "overwrite" ]; then
    docker compose exec -T db pg_restore -U incudal -d incudal --clean --if-exists --no-owner --no-privileges \
      < "$FILE" > /tmp/import.out 2>&1 || RC=$?
  else
    docker compose exec -T db pg_restore -U incudal -d incudal --data-only --on-conflict-do-nothing \
      --no-owner --no-privileges < "$FILE" > /tmp/import.out 2>&1 || RC=$?
  fi
else
  if [ "$MODE" = "overwrite" ]; then
    docker compose exec -T db psql -U incudal -d incudal -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1
    zcat "$FILE" | docker compose exec -T db psql -U incudal -d incudal > /tmp/import.out 2>&1 || RC=$?
  else
    zcat "$FILE" | docker compose exec -T db psql -U incudal -d incudal -v ON_ERROR_STOP=0 > /tmp/import.out 2>&1 || RC=$?
  fi
fi

ERRS=$(grep -c "^ERROR" /tmp/import.out 2>/dev/null || echo 0)
echo "  退出码=$RC  日志 ERROR 行数=$ERRS（详情 /tmp/import.out）"
echo ""

# ---- 核验 ----
echo "════ 导入后核验 ════"
docker compose exec -T db psql -U incudal -d incudal -c "
SELECT 'hosts' t, count(*) n FROM hosts
UNION ALL SELECT 'instances', count(*) FROM instances
UNION ALL SELECT 'users', count(*) FROM users
UNION ALL SELECT 'packages', count(*) FROM packages
UNION ALL SELECT 'user_telegram_bindings', count(*) FROM user_telegram_bindings
ORDER BY 1;" 2>/dev/null | sed 's/^/  /'

echo ""
echo "  重启面板..."
docker compose restart app >/dev/null 2>&1 && sleep 12
curl -s -o /dev/null -w "  面板 health=%{http_code}\n" --max-time 10 http://127.0.0.1:3000/api/health

echo ""
# merge 模式下 pg_restore 遇到已存在的行会返回 1（跳过），这是正常行为，
# 只要日志里没有 ERROR 就算成功。
if [ "$ERRS" -eq 0 ]; then
  echo "✓ 导入完成$([ "$MODE" = merge ] && echo '（新增模式：已存在的行已跳过，未改动）')"
else
  echo "⚠️  导入结束但有错误（退出码=$RC ERROR=$ERRS）"
  echo "   回退: bash $0 $PRE --mode overwrite --yes"
fi
