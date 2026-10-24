#!/bin/bash
# ============================================================
# Incudal 面板 · 备份脚本安装器
#
# 把三个宿主机脚本装到 /usr/local/bin，并只装「触发器」的每分钟 cron：
#   incudal-backup.sh          真正执行备份（本地 / GitHub / rclone）
#   incudal-restore.sh         导入 / 恢复
#   incudal-backup-trigger.sh  面板写的 .request 由它执行（每分钟）
#
# 注意：**不安装每日备份的 cron**。自动备份默认关闭，只有在面板
# 「数据备份 → 启用自动备份」里打开后，触发器才会写 crontab。
#
# 用法：sudo bash install-backup.sh [--uninstall]
# ============================================================
set -uo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../server/templates/backup" 2>/dev/null && pwd)"
# 项目目录：默认取脚本所在仓库根；用 APP_DIR=/path 可覆盖（比如从别处 clone 过来跑）
PROJECT_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)}"
BIN_DIR="/usr/local/bin"
BACKUP_DIR="/srv/incudal-backups"
CONF="/srv/incudal-backup.conf"

info() { printf '\033[36m[i]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[✓]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[✗]\033[0m %s\n' "$*" >&2; }

[[ $EUID -eq 0 ]] || { err "请用 root 运行"; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  info "卸载备份触发器 cron（保留已有备份文件）"
  TMP=$(mktemp)
  crontab -l 2>/dev/null | grep -v "/usr/local/bin/incudal-backup-trigger.sh" > "$TMP"
  crontab "$TMP" 2>/dev/null || true
  rm -f "$TMP"
  rm -f "$BIN_DIR/incudal-backup.sh" "$BIN_DIR/incudal-restore.sh" "$BIN_DIR/incudal-backup-trigger.sh"
  ok "已卸载（/srv/incudal-backups 与 $CONF 保留）"
  exit 0
fi

[[ -d "$SRC_DIR" ]] || { err "找不到脚本目录: $SRC_DIR"; exit 1; }

install -m 0755 "$SRC_DIR/backup.sh"  "$BIN_DIR/incudal-backup.sh"  || { err "安装 backup.sh 失败"; exit 1; }
install -m 0755 "$SRC_DIR/restore.sh" "$BIN_DIR/incudal-restore.sh" || { err "安装 restore.sh 失败"; exit 1; }
install -m 0755 "$SRC_DIR/trigger.sh" "$BIN_DIR/incudal-backup-trigger.sh" || { err "安装 trigger.sh 失败"; exit 1; }
ok "脚本已安装到 $BIN_DIR"

mkdir -p "$BACKUP_DIR"

# 面板容器内运行用户是 uid 1001 / gid 65533；目录和配置文件必须归它所有，
# 否则面板保存配置会 EACCES（触发器以 root 运行，不受影响）。
BACKUP_UID="${BACKUP_UID:-1001}"
BACKUP_GID="${BACKUP_GID:-65533}"
chown "$BACKUP_UID:$BACKUP_GID" "$BACKUP_DIR" 2>/dev/null || warn "chown $BACKUP_DIR 失败（用户不存在？）"
chmod 750 "$BACKUP_DIR"

# 配置文件：不存在才创建，且默认 AUTO_BACKUP=off
# 特例：如果 docker 先把 bind mount 的目标建成了目录（容器在文件存在前启动过），
# 这里清掉空目录再建文件，否则面板永远写不了配置。
if [[ -d "$CONF" ]]; then
  if rmdir "$CONF" 2>/dev/null; then
    ok "清理了误建的目录 $CONF"
  else
    err "$CONF 是目录且非空，请先手动处理（mv $CONF ${CONF}.bak 后重跑）"
    exit 1
  fi
fi

if [[ ! -f "$CONF" ]]; then
  cat > "$CONF" <<'CONFEOF'
# ===== Incudal 备份配置（改完直接生效，下次 cron 用新值）=====

# --- GitHub 私库 ---
GITHUB_ENABLED="false"
GITHUB_REPO=""
GITHUB_BRANCH="main"

# --- 网盘（rclone）---
RCLONE_ENABLED="false"
RCLONE_REMOTE=""
RCLONE_KEEP=30

# --- 本地保留 ---
KEEP_DAYS=14

# --- 自动备份（默认关闭）---
BACKUP_TIME="03:10"
BACKUP_TZ="Asia/Shanghai"
AUTO_BACKUP="off"
CONFEOF
  # 项目目录单独写入（heredoc 带引号不会展开变量）
  printf '\n# 面板项目目录（含 docker-compose.yml），装在不同路径时改这里\nAPP_DIR="%s"\n' "$PROJECT_DIR" >> "$CONF"
  chown "$BACKUP_UID:$BACKUP_GID" "$CONF" 2>/dev/null || true
  chmod 640 "$CONF"
  ok "已生成 $CONF（自动备份默认关闭，APP_DIR=$PROJECT_DIR）"
else
  info "$CONF 已存在，未覆盖"
  # 老配置文件补上 AUTO_BACKUP=off，避免「没配置却显示已启用」
  if ! grep -q '^APP_DIR=' "$CONF"; then
    printf '\n# 面板项目目录\nAPP_DIR="%s"\n' "$PROJECT_DIR" >> "$CONF"
    ok "已为老配置补上 APP_DIR=$PROJECT_DIR"
  fi
  if ! grep -q '^AUTO_BACKUP=' "$CONF"; then
    printf '\n# 自动备份默认关闭\nBACKUP_TIME="03:10"\nBACKUP_TZ="Asia/Shanghai"\nAUTO_BACKUP="off"\n' >> "$CONF"
    ok "已为老配置补上 AUTO_BACKUP=off"
  fi
fi

# 只装触发器（每分钟），不装每日备份
TMP=$(mktemp)
crontab -l 2>/dev/null | grep -v "/usr/local/bin/incudal-backup-trigger.sh" > "$TMP"
echo "* * * * * $BIN_DIR/incudal-backup-trigger.sh" >> "$TMP"
crontab "$TMP" || { rm -f "$TMP"; err "写入 crontab 失败"; exit 1; }
rm -f "$TMP"
ok "触发器 cron 已安装（每分钟），每日备份 cron 未安装"

# 立刻跑一次，生成 .status 供面板显示
"$BIN_DIR/incudal-backup-trigger.sh" >/dev/null 2>&1 || true
ok "完成。到面板「数据备份」里配置并开启自动备份即可"
