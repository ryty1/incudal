#!/bin/bash
# 宿主机侧的备份/导入触发器。
# 面板跑在容器里，没有 docker 权限也没有宿主机的 /root，所以它只能写一个
# 请求文件；这个脚本每分钟被 cron 调一次，看到请求就执行真正的备份/导入。
set -uo pipefail
DIR=/srv/incudal-backups
REQ="$DIR/.request"
RES="$DIR/.result"
mkdir -p "$DIR"

# 每次运行都刷新一份宿主机状态（面板在容器里看不到这些）
{
  echo "rclone=$(command -v rclone >/dev/null 2>&1 && echo yes || echo no)"
  echo "scripts=$( [ -x /usr/local/bin/incudal-backup.sh ] && [ -x /usr/local/bin/incudal-restore.sh ] && echo yes || echo no )"
  echo "sshkey=$( [ -f /root/.ssh/github_backup.pub ] && echo yes || echo no )"
  echo "at=$(date '+%F %T')"
} > "$DIR/.status" 2>/dev/null || true

[ -f "$REQ" ] || exit 0

# 抢占：把请求文件改名，避免同一请求被跑两次
MINE="$DIR/.running.$$"
mv "$REQ" "$MINE" 2>/dev/null || exit 0

ACTION=$(sed -n '1p' "$MINE")
ARG2=$(sed -n '2p' "$MINE")
ARG3=$(sed -n '3p' "$MINE")
rm -f "$MINE"

TS=$(date '+%F %T')
case "$ACTION" in
  run)
    OUT=$(bash /usr/local/bin/incudal-backup.sh 2>&1); RC=$?
    printf '%s|%s|%s\n' "$TS" "$RC" "$(echo "$OUT" | tail -20)" > "$RES"
    ;;
  import)
    # ARG2=文件名 ARG3=模式（overwrite|merge）
    case "$ARG3" in overwrite|merge) ;; *) ARG3=merge ;; esac
    case "$ARG2" in
      *[!A-Za-z0-9._-]*|'') echo "$TS|1|文件名不合法" > "$RES"; exit 0 ;;
    esac
    OUT=$(bash /usr/local/bin/incudal-restore.sh "$DIR/$ARG2" --mode "$ARG3" --yes 2>&1); RC=$?
    printf '%s|%s|%s\n' "$TS" "$RC" "$(echo "$OUT" | tail -40)" > "$RES"
    ;;
  install-rclone)
    OUT=$(DEBIAN_FRONTEND=noninteractive apt-get install -y rclone 2>&1); RC=$?
    {
      echo "rclone=$(command -v rclone >/dev/null 2>&1 && echo yes || echo no)"
      echo "scripts=$( [ -x /usr/local/bin/incudal-backup.sh ] && [ -x /usr/local/bin/incudal-restore.sh ] && echo yes || echo no )"
      echo "sshkey=$( [ -f /root/.ssh/github_backup.pub ] && echo yes || echo no )"
  echo "at=$(date '+%F %T')"
    } > "$DIR/.status" 2>/dev/null || true
    printf '%s|%s|%s\n' "$TS" "$RC" "$(echo "$OUT" | tail -10)" > "$RES"
    ;;
  gen-ssh-key)
    mkdir -p /root/.ssh && chmod 700 /root/.ssh
    if [ ! -f /root/.ssh/github_backup ]; then
      ssh-keygen -t ed25519 -f /root/.ssh/github_backup -N "" -C "incudal-backup" >/dev/null 2>&1
      RC=$?
    else
      RC=0
    fi
    if [ -f /root/.ssh/github_backup.pub ]; then
      grep -q "IdentityFile /root/.ssh/github_backup" /root/.ssh/config 2>/dev/null ||         printf 'Host github.com\n  IdentityFile /root/.ssh/github_backup\n  StrictHostKeyChecking no\n' >> /root/.ssh/config
      chmod 600 /root/.ssh/github_backup 2>/dev/null || true
      cp -f /root/.ssh/github_backup.pub "$DIR/.github_key_pub" 2>/dev/null || true
      chmod 644 "$DIR/.github_key_pub" 2>/dev/null || true
      printf '%s|0|公钥已生成\n' "$TS" > "$RES"
    else
      printf '%s|1|密钥生成失败\n' "$TS" > "$RES"
    fi
    {
      echo "rclone=$(command -v rclone >/dev/null 2>&1 && echo yes || echo no)"
      echo "scripts=$( [ -x /usr/local/bin/incudal-backup.sh ] && [ -x /usr/local/bin/incudal-restore.sh ] && echo yes || echo no )"
      echo "sshkey=$( [ -f /root/.ssh/github_backup.pub ] && echo yes || echo no )"
      echo "at=$(date '+%F %T')"
    } > "$DIR/.status" 2>/dev/null || true
    ;;
  set-schedule)
    # ARG2=HH:MM  ARG3=时区
    HHMM="$ARG2"; TZONE="$ARG3"
    case "$HHMM" in
      [0-9][0-9]:[0-9][0-9]) ;;
      *) echo "$TS|1|时间格式不对（应为 HH:MM）" > "$RES"; exit 0 ;;
    esac
    H="${HHMM%%:*}"; M="${HHMM##*:}"
    case "$TZONE" in
      [A-Za-z]*/*) ;;
      *) TZONE="Asia/Shanghai" ;;
    esac
    if [ ! -f /usr/share/zoneinfo/"$TZONE" ]; then
      echo "$TS|1|时区不存在: $TZONE" > "$RES"; exit 0
    fi
    # 重写 crontab：只动 CRON_TZ 和备份那一行，其余（含流量监控）原样保留
    TMP=$(mktemp)
    # 先彻底清掉所有备份行（含旧时间），再写唯一一条
    crontab -l 2>/dev/null | grep -v "^CRON_TZ=" | grep -vE "/usr/local/bin/incudal-backup\.sh" > "$TMP"
    { echo "CRON_TZ=$TZONE"; cat "$TMP"; echo "$M $H * * * /usr/local/bin/incudal-backup.sh"; } | crontab -
    rm -f "$TMP"
    echo "$TS|0|备份时间已设为 $HHMM（$TZONE）" > "$RES"
    ;;
  verify-archive)
    # 兼容两种：.dump（pg_restore 归档）与 .sql.gz（gzip 压的纯 SQL）
    if gzip -t "$DIR/.upload_tmp" 2>/dev/null; then
      # 是 gzip：解出来看有没有 CREATE TABLE
      N=$(zcat "$DIR/.upload_tmp" 2>/dev/null | grep -c "^CREATE TABLE" || true)
      if [ "${N:-0}" -gt 0 ]; then
        echo "$TS|0|SQL 归档有效（$N 张表）" > "$RES"
      else
        echo "$TS|1|gzip 能解开但里面没有 CREATE TABLE，不是数据库备份" > "$RES"
      fi
    elif docker compose -f /home/docker/incudal/docker-compose.yml cp "$DIR/.upload_tmp" db:/tmp/_up.dump >/dev/null 2>&1 \
       && docker compose -f /home/docker/incudal/docker-compose.yml exec -T db pg_restore --list /tmp/_up.dump >/dev/null 2>&1; then
      docker compose -f /home/docker/incudal/docker-compose.yml exec -T db rm -f /tmp/_up.dump >/dev/null 2>&1 || true
      echo "$TS|0|pg_dump 归档有效" > "$RES"
    else
      echo "$TS|1|既不是 gzip 也不是 pg_dump 归档" > "$RES"
    fi
    ;;
  set-auto)
    # ARG2=on|off
    TMP=$(mktemp)
    crontab -l 2>/dev/null | grep -vE "/usr/local/bin/incudal-backup\.sh" > "$TMP"
    if [ "$ARG2" = "on" ]; then
      # 从 conf 读回时间和时区
      . /srv/incudal-backup.conf 2>/dev/null || true
      T="${BACKUP_TIME:-03:10}"; Z="${BACKUP_TZ:-Asia/Shanghai}"
      case "$T" in [0-9][0-9]:[0-9][0-9]) ;; *) T="03:10" ;; esac
      H="${T%%:*}"; M="${T##*:}"
      crontab -l 2>/dev/null | grep -v "^CRON_TZ=" | grep -vE "/usr/local/bin/incudal-backup\.sh" > "$TMP"
      { echo "CRON_TZ=$Z"; cat "$TMP"; echo "$M $H * * * /usr/local/bin/incudal-backup.sh"; } | crontab -
      echo "$TS|0|自动备份已开启（每天 $T）" > "$RES"
    else
      grep -v "^CRON_TZ=" "$TMP" > "$TMP.2" 2>/dev/null || true
      crontab "$TMP.2" 2>/dev/null || crontab "$TMP"
      rm -f "$TMP.2"
      echo "$TS|0|自动备份已关闭" > "$RES"
    fi
    rm -f "$TMP"
    ;;
  git-list)
    # 列出 GitHub 工作副本里的备份（文件名|字节数|修改时间戳）
    REPO=/root/incudal-git-backup
    if [ -d "$REPO/.git" ]; then
      # 不要在这里 git fetch —— 要走网络，慢的时候会让面板请求超时。
      # 工作副本在每次备份推送时就已经是最新的了，直接列本地即可。
      cd "$REPO" || { echo "$TS|1|无法进入仓库" > "$RES"; exit 0; }
      OUT=$(ls -l --time-style=+%s "$REPO"/incudal-*.dump 2>/dev/null | awk '{print $NF"|"$5"|"$6}')
      printf '%s|0|%s\n' "$TS" "$(echo "$OUT" | tr '\n' ';')" > "$RES"
    else
      echo "$TS|0|" > "$RES"
    fi
    ;;
  clear-log)
    : > /srv/incudal-backups/backup.log 2>/dev/null && \
      echo "$TS|0|日志已清空" > "$RES" || echo "$TS|1|清空失败" > "$RES"
    ;;
  git-get)
    # ARG2=文件名 → 从仓库工作副本复制到备份目录，供下载/导入使用
    REPO=/root/incudal-git-backup
    NAME="$ARG2"
    case "$NAME" in *[!A-Za-z0-9._-]*|'') echo "$TS|1|文件名不合法" > "$RES"; exit 0 ;; esac
    if [ -f "$REPO/$NAME" ]; then
      cp -f "$REPO/$NAME" "/srv/incudal-backups/$NAME" && chmod 644 "/srv/incudal-backups/$NAME" \
        && echo "$TS|0|已取出 $NAME" > "$RES" || echo "$TS|1|复制失败" > "$RES"
    else
      echo "$TS|1|仓库里没有 $NAME" > "$RES"
    fi
    ;;
  git-del)
    # ARG2=文件名 → 从仓库删除并提交推送（同步到 GitHub）
    REPO=/root/incudal-git-backup
    NAME="$ARG2"
    case "$NAME" in *[!A-Za-z0-9._-]*|'') echo "$TS|1|文件名不合法" > "$RES"; exit 0 ;; esac
    cd "$REPO" 2>/dev/null || { echo "$TS|1|仓库不存在" > "$RES"; exit 0; }
    if [ ! -f "$NAME" ]; then echo "$TS|1|仓库里没有 $NAME" > "$RES"; exit 0; fi
    git rm --quiet "$NAME" 2>/dev/null || rm -f "$NAME"
    if git -c user.name="incudal-backup" -c user.email="backup@local" commit -q -m "delete: $NAME" 2>/dev/null; then
      if git push --quiet origin "$(git rev-parse --abbrev-ref HEAD)" 2>/tmp/gitdel.err; then
        echo "$TS|0|已从 GitHub 删除并推送" > "$RES"
      else
        echo "$TS|1|本地已删但推送失败: $(head -c 150 /tmp/gitdel.err)" > "$RES"
      fi
    else
      echo "$TS|1|提交失败" > "$RES"
    fi
    ;;
  *)
    echo "$TS|1|未知动作" > "$RES"
    ;;
esac
