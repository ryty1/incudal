#!/bin/bash
# ============================================================
# Incudal 面板 · 数据库自动备份（本地 + GitHub 私库 + 网盘）
#
# 安全保证：全程只读（pg_dump），绝不写库。
# 格式用 -Fc（PostgreSQL 自定义格式）：内置压缩；导入时可选「覆盖」或「只新增」。
# 配置：/root/incudal-backup.conf（首次运行自动生成模板）
# ============================================================
set -uo pipefail

APP_DIR="/home/docker/incudal"
BACKUP_DIR="/srv/incudal-backups"
CONF="/srv/incudal-backup.conf"
KEEP_DAYS=14
LOG="$BACKUP_DIR/backup.log"
LOCK="/tmp/incudal-backup.lock"

GITHUB_ENABLED="false"
GITHUB_REPO=""
GITHUB_BRANCH="main"
RCLONE_ENABLED="false"
RCLONE_REMOTE=""
RCLONE_KEEP=30

[ -f "$CONF" ] && . "$CONF"

exec 9>"$LOCK"
flock -n 9 || { echo "[$(date '+%F %T')] 已有备份在跑，跳过" >> "$LOG"; exit 0; }
mkdir -p "$BACKUP_DIR"

TS=$(date '+%Y%m%d-%H%M%S')
FILE="$BACKUP_DIR/incudal-$TS.dump"
FAIL=0
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# ---------- 1. dump（自定义格式，只读）----------
cd "$APP_DIR" || { log "✗ 找不到 $APP_DIR"; exit 1; }
if docker compose exec -T db pg_dump -U incudal -d incudal -Fc --no-owner --no-privileges > "$FILE" 2>/tmp/pgdump.err; then
  SIZE=$(stat -c%s "$FILE" 2>/dev/null || echo 0)
  # 完整性校验：pg_restore --list 能读出条目（用 grep -c 读全量，不用 grep -q 以免 SIGPIPE 误判）
  # pg_restore 只在 db 容器里；且该环境 docker exec 的 stdin 重定向无效
  # （报 did not find magic string），必须先把文件 cp 进容器再 --list。
  docker compose cp "$FILE" db:/tmp/_verify.dump >/dev/null 2>&1
  ITEMS=$(docker compose exec -T db pg_restore --list /tmp/_verify.dump 2>/dev/null | grep -c "TABLE DATA" || true)
  docker compose exec -T db rm -f /tmp/_verify.dump >/dev/null 2>&1
  if [ "$SIZE" -gt 4096 ] && [ "${ITEMS:-0}" -gt 50 ]; then
    log "✓ 本地备份成功 $(basename "$FILE") ($((SIZE/1024)) KB, $ITEMS 个表数据段)"
  else
    log "✗ 备份文件异常（size=$SIZE items=$ITEMS），已删除"
    rm -f "$FILE"; exit 1
  fi
else
  log "✗ pg_dump 失败: $(head -c 300 /tmp/pgdump.err 2>/dev/null | tr '\n' ' ')"
  rm -f "$FILE"; exit 1
fi

# ---------- 2. 推 GitHub 私库 ----------
if [ "$GITHUB_ENABLED" = "true" ] && [ -n "$GITHUB_REPO" ]; then
  REPO_DIR="/root/incudal-git-backup"
  if [ ! -d "$REPO_DIR/.git" ]; then
    rm -rf "$REPO_DIR"
    if ! git clone --quiet "$GITHUB_REPO" "$REPO_DIR" 2>/tmp/gitclone.err; then
      mkdir -p "$REPO_DIR" && cd "$REPO_DIR" && git init --quiet && \
        git remote add origin "$GITHUB_REPO" 2>/dev/null || true
    fi
  fi
  if [ -d "$REPO_DIR/.git" ]; then
    # 关键：空仓库 clone 后没有任何分支被检出 → 必须强制把本地分支建成目标分支名，
    # 否则 git push origin <branch> 会报 "src refspec ... does not match any"
    cd "$REPO_DIR" || exit 1
    git symbolic-ref -q HEAD >/dev/null 2>&1 || git checkout -q -B "$GITHUB_BRANCH" 2>/dev/null || true
    git remote get-url origin >/dev/null 2>&1 || git remote add origin "$GITHUB_REPO" 2>/dev/null || true
    git rev-parse --abbrev-ref HEAD 2>/dev/null | grep -q "^$GITHUB_BRANCH$" || \
      git checkout -q -B "$GITHUB_BRANCH" 2>/dev/null || true
    git config user.name "incudal-backup" 2>/dev/null || true
    git config user.email "backup@local" 2>/dev/null || true
    cp -f "$FILE" "$REPO_DIR/" 2>/dev/null
    cd "$REPO_DIR" || exit 1
    # 清理：只保留最近 GITHUB_KEEP_DAYS 天的备份（按文件年龄，不是按个数）
    find "$REPO_DIR" -maxdepth 1 -type f -name 'incudal-*.dump' -mtime +${GITHUB_KEEP_DAYS:-7} -print 2>/dev/null | while read -r old; do
      rm -f "$old"
      git rm --quiet --cached --ignore-unmatch "$(basename "$old")" 2>/dev/null || true
    done
    # 历史压缩：提交数超过 20 就用 orphan 分支重建，把历史压成 1 个提交，
    # 否则就算删了文件，旧 blob 仍留在 git 历史里，仓库会无限膨胀
    CNT=$(git rev-list --count HEAD 2>/dev/null || echo 0)
    if [ "${CNT:-0}" -gt 20 ]; then
      if git checkout -q --orphan "_squash_$TS" 2>/dev/null; then
        git add -A >/dev/null 2>&1
        git -c user.name="incudal-backup" -c user.email="backup@local" commit -q -m "squash: $TS" 2>/dev/null
        git branch -D "$GITHUB_BRANCH" >/dev/null 2>&1 || true
        git branch -m "$GITHUB_BRANCH" 2>/dev/null || true
        git push --quiet -f --set-upstream origin "$GITHUB_BRANCH" 2>/dev/null && \
          log "· GitHub 历史已压缩（原 $CNT 个提交 → 1 个）"
      fi
    fi
    git add -A >/dev/null 2>&1
    if git diff --cached --quiet 2>/dev/null; then
      log "· GitHub: 无变化，跳过提交"
    elif git -c user.name="incudal-backup" -c user.email="backup@local" commit -q -m "backup: $TS" 2>/dev/null; then
      if git push --quiet --set-upstream origin "$GITHUB_BRANCH" 2>/tmp/gitpush.err; then
        log "✓ GitHub 私库推送成功（$TS）"
        # 启用 GitHub 时本地不留备份：push 成功就把本地那份删掉
        # （本地只做临时中转，真正的归档在 GitHub 私库里）
        if rm -f "$FILE" 2>/dev/null; then
          log "· 已按配置删除本地备份（启用 GitHub 私库时不留本地副本）"
        fi
      else
        log "✗ GitHub 推送失败: $(head -c 200 /tmp/gitpush.err 2>/dev/null | tr '\n' ' ')"; FAIL=1
      fi
    else
      log "✗ GitHub 提交失败"; FAIL=1
    fi
  else
    log "✗ GitHub 仓库不可用: $GITHUB_REPO"; FAIL=1
  fi
fi

# ---------- 4. 清理本地过期 ----------
# 启用 GitHub 时本地本来就不留文件，这一段会自然跳过
# 安全保护：无论保留天数怎么设，都至少保留最近 3 份，且绝不删掉最新那份
TOTAL=$(ls -1t "$BACKUP_DIR"/incudal-*.dump 2>/dev/null | wc -l)
if [ "${TOTAL:-0}" -gt 3 ]; then
  # 跳过最新的 3 份，只对更老的做过期清理
  DEL=0
  ls -1t "$BACKUP_DIR"/incudal-*.dump 2>/dev/null | tail -n +4 | while read -r f; do
    if [ -n "$(find "$f" -mtime +$KEEP_DAYS 2>/dev/null)" ]; then
      rm -f "$f" && DEL=$((DEL+1))
    fi
  done
  DEL=$(ls -1t "$BACKUP_DIR"/incudal-*.dump 2>/dev/null | tail -n +4 | while read -r f; do find "$f" -mtime +$KEEP_DAYS -print 2>/dev/null; done | wc -l)
  [ "$DEL" -gt 0 ] && log "已清理 $DEL 个超过 ${KEEP_DAYS} 天的本地备份（始终保留最近 3 份）"
fi

# ---------- 5. 日志瘦身 ----------
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 500 ]; then
  tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# ---------- 6. 首次运行生成配置模板 ----------
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<'CONFEOF'
# ===== Incudal 备份配置（改完直接生效，下次 cron 用新值）=====

# --- GitHub 私库 ---
# 1) GitHub 建一个【私有】仓库，例如 incudal-backups
# 2) 生成部署密钥（需要写权限）：
#      ssh-keygen -t ed25519 -f /root/.ssh/github_backup -N ""
#      cat /root/.ssh/github_backup.pub   → 粘到仓库 Settings → Deploy keys，勾 Allow write access
# 3) 配 SSH：
#      printf 'Host github.com\n  IdentityFile /root/.ssh/github_backup\n  StrictHostKeyChecking no\n' >> /root/.ssh/config
# 4) 填下面两项并把开关改成 true
GITHUB_ENABLED="false"
GITHUB_REPO=""                       # git@github.com:你的用户名/incudal-backups.git
GITHUB_BRANCH="main"

# --- 网盘（rclone：Google Drive / OneDrive / WebDAV / S3 / R2 / 坚果云…）---
# 1) apt install rclone
# 2) rclone config     （按向导配一个 remote，比如叫 gdrive）
# 3) rclone lsd gdrive:  （验证可用）
# 4) 填下面两项并把开关改成 true
RCLONE_ENABLED="false"
RCLONE_REMOTE=""                     # 例: gdrive:incudal-backups   或  webdav:/incudal
RCLONE_KEEP=30                       # 远端保留天数（0=不清理）

# --- 本地保留 ---
KEEP_DAYS=14

# --- 自动备份（默认关闭：面板后台「数据备份」里开启后才会写 crontab）---
BACKUP_TIME="03:10"
BACKUP_TZ="Asia/Shanghai"
AUTO_BACKUP="off"
CONFEOF
  log "已生成配置模板 $CONF（编辑它开启 GitHub / 网盘）"
fi

exit $FAIL
