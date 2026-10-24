#!/bin/bash
# ============================================================
# Incudal 备份脚本 · 远程安装器（由面板提供，不需要 git 仓库）
#
# 用法（在面板宿主机上执行）：
#   curl -fsSL <PANEL_URL>/api/hosts/install-backup.sh -o /tmp/ib.sh
#   sudo APP_DIR=/root/incudal bash /tmp/ib.sh
#
# 为什么不在镜像里：这三个脚本要装到宿主机（crontab、docker、/root/.ssh
# 都是宿主机资源），容器里既没有 cron 也碰不到 /root，所以只能由宿主机执行。
# 新装机器由 scripts/install-docker.sh 自动调用；已装机器跑这一条即可。
# ============================================================
set -uo pipefail

PANEL_URL="${PANEL_URL:-__PANEL_URL__}"
APP_DIR="${APP_DIR:-}"
BIN_DIR="/usr/local/bin"
BACKUP_DIR="/srv/incudal-backups"
CONF="/srv/incudal-backup.conf"
BACKUP_UID="${BACKUP_UID:-1001}"
BACKUP_GID="${BACKUP_GID:-65533}"

info() { printf '\033[36m[i]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[✓]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[✗]\033[0m %s\n' "$*" >&2; }

[[ $EUID -eq 0 ]] || { err "请用 root 运行"; exit 1; }
[[ -n "$PANEL_URL" ]] || { err "缺少 PANEL_URL"; exit 1; }
PANEL_URL="${PANEL_URL%/}"

# 自动探测项目目录（含 docker-compose.yml 的那个）
if [[ -z "$APP_DIR" || ! -d "$APP_DIR" ]]; then
  for d in /root/incudal /home/docker/incudal /opt/incudal /srv/incudal; do
    if [[ -f "$d/docker-compose.yml" ]]; then APP_DIR="$d"; break; fi
  done
fi
[[ -n "$APP_DIR" && -d "$APP_DIR" ]] || { err "找不到项目目录，请用 APP_DIR=/路径 指定"; exit 1; }
ok "项目目录: $APP_DIR"

# ---- 1. 下载三个脚本 ----
for pair in "backup.sh:incudal-backup.sh" "restore.sh:incudal-restore.sh" "trigger.sh:incudal-backup-trigger.sh"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  if ! curl -fsSL --max-time 60 "$PANEL_URL/api/hosts/backup-scripts/$src" -o "/tmp/$dst" 2>/dev/null || [[ ! -s "/tmp/$dst" ]]; then
    err "下载 $src 失败（$PANEL_URL/api/hosts/backup-scripts/$src）"; exit 1
  fi
  install -m 0755 "/tmp/$dst" "$BIN_DIR/$dst" || { err "安装 $dst 失败"; exit 1; }
  rm -f "/tmp/$dst"
done
ok "脚本已安装到 $BIN_DIR"

# ---- 2. 目录与配置 ----
mkdir -p "$BACKUP_DIR"
chown "$BACKUP_UID:$BACKUP_GID" "$BACKUP_DIR" 2>/dev/null || true
chmod 750 "$BACKUP_DIR"

if [[ -d "$CONF" ]]; then
  if rmdir "$CONF" 2>/dev/null; then ok "清理了误建的目录 $CONF"; else err "$CONF 是目录且非空，请手动处理"; exit 1; fi
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

# 同一天只保留最新一份备份（false = 保留当天多份）
KEEP_ONE_PER_DAY="true"
CONFEOF
  ok "已生成 $CONF（自动备份默认关闭）"
else
  info "$CONF 已存在，未覆盖"
fi

if ! grep -q '^APP_DIR=' "$CONF"; then
  printf '\n# 面板项目目录（含 docker-compose.yml）\nAPP_DIR="%s"\n' "$APP_DIR" >> "$CONF"
  ok "已写入 APP_DIR=$APP_DIR"
fi
if ! grep -q '^KEEP_ONE_PER_DAY=' "$CONF"; then
  printf '\n# 同一天只保留最新一份\nKEEP_ONE_PER_DAY="true"\n' >> "$CONF"
fi
chown "$BACKUP_UID:$BACKUP_GID" "$CONF" 2>/dev/null || true
chmod 640 "$CONF"

# ---- 3. cron：只装触发器，不装每日备份 ----
TMP=$(mktemp)
crontab -l 2>/dev/null | grep -v "/usr/local/bin/incudal-backup-trigger.sh" > "$TMP"
echo "* * * * * $BIN_DIR/incudal-backup-trigger.sh" >> "$TMP"
crontab "$TMP" || { rm -f "$TMP"; err "写入 crontab 失败"; exit 1; }
rm -f "$TMP"
ok "触发器 cron 已安装（每分钟）"

"$BIN_DIR/incudal-backup-trigger.sh" >/dev/null 2>&1 || true
ok "完成。到面板「数据备份」里配置并开启自动备份即可"
