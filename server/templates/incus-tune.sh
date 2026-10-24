#!/usr/bin/env bash
# incus-tune.sh — 现有节点补丁：压低 Incus 相关常驻内存（最轻量化版）
# 逻辑与面板安装脚本里的 tune_incus_memory() / setup_v6_guardian() 保持一致，
# 保证新旧节点行为统一。幂等、可重复执行、不中断容器。
# 兼容：Debian 12/13、Ubuntu 22.04/24.04；ZFS 与非 ZFS 存储均可；
#      服务不存在 / 无 systemd / Go 版本旧 一律自动跳过。
# 用法：curl -fsSL <URL> | bash
set -u

[ "$(id -u)" = "0" ] || { echo "请用 root 运行"; exit 1; }
if ! command -v systemctl >/dev/null 2>&1; then echo "无 systemd，退出"; exit 0; fi

MEMTOTAL=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
[[ "$MEMTOTAL" =~ ^[0-9]+$ ]] || MEMTOTAL=0
MEMAVAIL=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
[[ "$MEMAVAIL" =~ ^[0-9]+$ ]] || MEMAVAIL=0
# Go 软内存上限：内存的 1/3（下限 256MiB，上限 3GiB）。
# 必须【显著高于】incusd 的常驻堆（实测 1G 节点 anon 已达 137MB），
# 压到堆以下会让 Go 持续强制 GC，反而烧 CPU、拖慢 API。
GLIMIT=$(( MEMTOTAL / 3 )); [ "$GLIMIT" -lt 256 ] && GLIMIT=256; [ "$GLIMIT" -gt 3072 ] && GLIMIT=3072
[ "$MEMTOTAL" -gt 0 ] || GLIMIT=256
# ZFS ARC 目标上限：内存的 1/8（下限 64MiB，上限 3GiB）
ARCTARGET=$(( MEMTOTAL / 4 )); [ "$MEMAVAIL" -gt 0 ] && { _cap=$(( MEMAVAIL * 6 / 10 )); [ "$_cap" -lt "$ARCTARGET" ] && ARCTARGET=$_cap; }; [ "$ARCTARGET" -lt 64 ] && ARCTARGET=64; [ "$ARCTARGET" -gt 8192 ] && ARCTARGET=8192

cg_bytes() { cat "/sys/fs/cgroup/system.slice/$1/memory.current" 2>/dev/null || echo 0; }
cg_anon()  { awk '/^anon /{print $2}' "/sys/fs/cgroup/system.slice/$1/memory.stat" 2>/dev/null || echo 0; }
mb()       { awk -v b="${1:-0}" 'BEGIN{printf "%.0f", b/1048576}'; }
count_running() {
  local n
  n=$(incus list --format csv -c s 2>/dev/null | grep -ci 'RUNNING' || true)
  echo "${n:-0}"
}

echo "============ 优化前（内存 ${MEMTOTAL} MB）============"
free -m | sed -n '1,2p' | sed 's/^/  /'
printf "  incus.service    合计 %s MB（真实堆 anon %s MB）\n" \
  "$(mb "$(cg_bytes incus.service)")" "$(mb "$(cg_anon incus.service)")"
for s in incus-v6-guardian multipathd fwupd ModemManager systemd-journald; do
  v=$(cg_bytes "$s.service")
  [ "${v:-0}" -gt 0 ] && printf "  %-22s %s MB\n" "$s.service" "$(mb "$v")"
done
echo "  incusd 进程数: $(pgrep -c incusd 2>/dev/null || echo 0)（其中 forkproxy: $(pgrep -fc 'incusd forkproxy' 2>/dev/null || echo 0)）"
BEFORE_RUN=$(count_running)
echo "  运行中容器: ${BEFORE_RUN} 台"
echo
echo "  说明：cgroup「合计」含文件缓存（可回收），真实占用看 anon 那一项。"
echo

CHANGED=false

# ① Incus GC 调优（最大头）：Go 的 RSS 只涨不还，GOMEMLIMIT 让它主动回收。
#    环境变量会被 incusd 的所有子进程（forkproxy 等）继承，所以对端口映射进程同样生效。
if systemctl cat incus.service >/dev/null 2>&1; then
  echo "---- ① Incus GC 调优：GOMEMLIMIT=${GLIMIT}MiB + GOGC=50 ----"
  mkdir -p /etc/systemd/system/incus.service.d
  cat > /etc/systemd/system/incus.service.d/10-mem.conf <<EOF
[Service]
# GOMEMLIMIT：Go 软内存上限，GC 接近该值时积极回收，避免 RSS 只涨不还
Environment=GOMEMLIMIT=${GLIMIT}MiB
# GOGC：默认 100；50 = 更早回收，堆更小（GC 稍频繁，CPU 几乎无感）
Environment=GOGC=50
EOF
  echo "  已写入 /etc/systemd/system/incus.service.d/10-mem.conf"
  CHANGED=true
else
  echo "---- ① 未检测到 incus.service，跳过 ----"
fi

# ② 关闭一切非必需的服务与定时器
#    只保留：系统必需 + Incus 必需 + 面板 Agent。
#    明确不动（写出来是为了以后有人问「为什么关这个不关那个」）：
#      systemd-* / dbus / polkit / ssh / incus / incus-lxcfs / incus-startup /
#      incudal-agent / apparmor / ndppd(IPv6) / zfs-zed / cron / timesyncd /
#      serial-getty@ttyS0(云控制台) / user@0
#    特意不动的高风险项：systemd-resolved（resolv.conf 指向它，关了断 DNS）、
#      cloud-init（关了重启可能丢网络配置）
echo "---- ② 关闭非必需服务与定时器 ----"

DISABLE_SERVICES="
multipathd fwupd ModemManager udisks2 packagekit accounts-daemon motd-news
unattended-upgrades rsyslog apport e2scrub_reap
snapd snapd.apparmor snapd.autoimport snapd.core-fixup snapd.seeded snapd.system-shutdown
open-iscsi open-vm-tools lvm2-monitor blk-availability
grub-common grub-initrd-fallback
console-setup keyboard-setup setvtrgb
pollinate dmesg secureboot-db networkd-dispatcher systemd-pstore
getty@tty1
"
DISABLE_TIMERS="
apt-daily apt-daily-upgrade motd-news man-db
update-notifier-download update-notifier-motd
fwupd-refresh sysstat-collect sysstat-summary e2scrub_all
apport-autoreport snapd.snap-repair ua-timer
"

# 注意：必须用 mask，不能只 disable。
# 实测 multipathd 在 disable 之后仍会被重新激活（is-enabled=disabled 却 is-active=active），
# 白丢 26MB。mask 建立 /dev/null 软链，任何依赖都无法再拉起它。
_disable_unit() {
  systemctl cat "$1" >/dev/null 2>&1 || return 0
  local was
  was=$(systemctl is-enabled "$1" 2>/dev/null)
  if [ "$was" = "masked" ]; then return 0; fi
  systemctl disable --now "$1" >/dev/null 2>&1 || true
  if systemctl mask "$1" >/dev/null 2>&1; then
    echo "  已屏蔽 $1（stop + disable + mask）"
    CHANGED=true
  fi
}

for u in $DISABLE_SERVICES; do _disable_unit "${u}.service"; done
for u in $DISABLE_TIMERS;  do _disable_unit "${u}.timer";   done

# irqbalance：小核数虚拟机没有收益（网卡队列少），核数多的大机器保留
if [ "$(nproc 2>/dev/null || echo 0)" -le 4 ]; then
  _disable_unit irqbalance.service
fi

# snapd 只在「一个 snap 包都没有」时才关，避免误伤 snap 安装的组件
if command -v snap >/dev/null 2>&1; then
  if [ "$(snap list 2>/dev/null | tail -n +2 | wc -l)" -eq 0 ]; then
    systemctl disable --now snapd.service snapd.socket >/dev/null 2>&1 || true
    systemctl mask snapd.service snapd.socket snapd.seeded.service >/dev/null 2>&1 || true
    echo "  无 snap 包 → 已屏蔽 snapd"
  else
    echo "  存在 snap 包 → 保留 snapd（不动）"
  fi
fi

echo "  ⚠ 已一并关闭自动安全更新（unattended-upgrades / apt-daily）"
echo "     需要恢复：systemctl enable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades"

# ③ journald 限额（大机器上默认能吃到近百 MB）
echo "---- ③ journald 日志限额 ----"
if systemctl cat systemd-journald.service >/dev/null 2>&1; then
  mkdir -p /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/10-size.conf <<'EOF'
[Journal]
SystemMaxUse=16M
RuntimeMaxUse=8M
SystemMaxFileSize=8M
EOF
  systemctl restart systemd-journald >/dev/null 2>&1 && echo "  日志上限已收紧为 16M"
  CHANGED=true
fi

# ④ ZFS ARC 上限：双向对齐到 ARCTARGET（过小也调大、过大也调小）。
#    原来只判「过大」→ 旧版写死 96MiB 的节点永远调不上来，arc_prune 常驻烧 CPU。
echo "---- ④ ZFS ARC 上限（目标 ${ARCTARGET}MiB）----"
if [ -w /sys/module/zfs/parameters/zfs_arc_max ]; then
  cur=$(cat /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || echo 0)
  curmb=$(( ${cur:-0} / 1048576 ))
  _diff=$(( curmb - ARCTARGET )); [ "$_diff" -lt 0 ] && _diff=$(( -_diff ))
  if [ "${cur:-0}" -eq 0 ] || [ "$_diff" -gt $(( ARCTARGET / 5 )) ]; then
    echo "$((ARCTARGET*1048576))" > /sys/module/zfs/parameters/zfs_arc_max 2>/dev/null || true
    if grep -q "zfs_arc_max" /etc/modprobe.d/zfs-tuning.conf 2>/dev/null; then
      python3 - "$ARCTARGET" <<'PY' 2>/dev/null || true
import io, re, sys
t = int(sys.argv[1])
p = '/etc/modprobe.d/zfs-tuning.conf'
s = io.open(p).read()
s = re.sub(r'zfs_arc_max=\d+', 'zfs_arc_max=%d' % (t * 1048576), s)
io.open(p, 'w').write(s)
PY
    else
      echo "options zfs zfs_arc_max=$((ARCTARGET*1048576))" >> /etc/modprobe.d/zfs-tuning.conf 2>/dev/null || true
    fi
    echo "  原上限 ${curmb}MiB → 对齐为 ${ARCTARGET}MiB（并持久化）"
    CHANGED=true
  else
    echo "  已有上限 ${curmb}MiB（≤ 目标），保持不变"
  fi
else
  echo "  非 ZFS，跳过"
fi

# ⑤ Guardian：常驻 while 循环 → systemd timer（15 秒节奏不变，功能不变）
#    同时修掉两个浪费：
#      · 旧版设备名 proxy-tcp-<port>-v6 也算「已打通」，不再每轮重试添加而失败
#        （这是「Updating instance 卡死」的根源：CLI 每 15 秒抢一次 daemon 锁）
#      · 一次 incus list 取齐 名称/状态/IPv4，省掉每容器一次的 CLI 调用
echo "---- ⑤ Guardian 常驻守护 → timer 调度 ----"
if [ -f /usr/local/bin/incus-v6-guardian.sh ]; then
  # ⚠️ 不再启用 15 秒版 guardian：它每轮对每个容器 spawn 多条 incus CLI，
  #    实测在 68 台容器的节点上烧掉约 24% 一个核（还会和 reconciler 抢锁）。
  #    它的职责（清理旧版 [::] 代理设备）已由 incudal-dnat-sync 完全覆盖。
  systemctl disable --now incus-v6-guardian.timer >/dev/null 2>&1 || true
  systemctl disable --now incus-v6-guardian.service >/dev/null 2>&1 || true
  echo "  guardian 已停用（职责由 incudal-dnat-sync reconciler 接管）"
else
  echo "  未安装 guardian，跳过"
fi

# ⑥ 内核缓存调优（实测 1G 节点 Slab 337MB + Cached 187MB，比 Incus 本身还大）
echo "---- ⑥ 内核缓存调优 ----"
if [ -d /etc/sysctl.d ]; then
  MFK=$(( MEMTOTAL * 1024 / 64 )); [ "$MFK" -lt 16384 ] && MFK=16384
  CUR_MFK=$(cat /proc/sys/vm/min_free_kbytes 2>/dev/null || echo 0)
  {
    echo "# Incudal: 小内存节点内核缓存调优（由优化补丁写入，删除本文件即可回滚）"
    echo "# 更积极回收 dentry/inode 缓存"
    echo "vm.vfs_cache_pressure = 200"
    echo "# 压低脏页上限，减少脏页缓存堆积"
    echo "vm.dirty_ratio = 10"
    echo "vm.dirty_background_ratio = 5"
    echo "# 单连接收发缓冲上限：默认 32MB 对 NAT VPS 过大，收到 4MB"
    echo "# （100Mbps × 高延迟也够用；内核按需分配，这里只是封顶）"
    echo "net.core.rmem_max = 4194304"
    echo "net.core.wmem_max = 4194304"
    echo "net.ipv4.tcp_rmem = 4096 87380 4194304"
    echo "net.ipv4.tcp_wmem = 4096 16384 4194304"
    [ "${CUR_MFK:-0}" -gt "$MFK" ] && echo "vm.min_free_kbytes = $MFK"
  } > /etc/sysctl.d/zz-incus-cache.conf
  sysctl --system >/dev/null 2>&1 || true
  echo "  vfs_cache_pressure=200 / dirty_ratio=10 / dirty_background_ratio=5 已生效"
  [ "${CUR_MFK:-0}" -gt "$MFK" ] && echo "  min_free_kbytes 由 $((CUR_MFK/1024))MiB 收到 $((MFK/1024))MiB（内核预留，收小=直接多出可用内存）"
  CHANGED=true
fi

# ⑦ 关闭 ftrace（实测常驻 9.5 万个 trace_event_file 对象）
echo "---- ⑦ 关闭 ftrace ----"
if [ -w /sys/kernel/tracing/tracing_on ]; then
  echo 0 > /sys/kernel/tracing/tracing_on 2>/dev/null || true
  echo > /sys/kernel/tracing/trace 2>/dev/null || true
  echo "  已关闭跟踪并清空缓冲区"
fi

if [ "$CHANGED" = "true" ]; then
  if [ "${SKIP_INCUS_RESTART:-0}" = "1" ]; then
    echo "---- ⑧ 已写入配置（按 SKIP_INCUS_RESTART=1 跳过重启）----"
    echo "  GOMEMLIMIT 等需要 incus 重启才生效，将在节点下次重启时自动生效"
  else
    # ⑨ 系统内核调优（针对 Incus NAT 宿主：多容器 + 大量连接跟踪 + 转发）
echo "---- ⑨ 系统内核调优 ----"
if [ -d /etc/sysctl.d ]; then
  cat > /etc/sysctl.d/99-incudal-node.conf <<'SYSCTL'
# ===== Incudal 节点内核调优（由 incus-tune.sh 生成）=====
vm.swappiness = 10
vm.overcommit_memory = 1
vm.max_map_count = 262144
vm.vfs_cache_pressure = 200
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1
net.ipv4.conf.default.rp_filter = 2
net.ipv4.conf.all.rp_filter = 2
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_syncookies = 1
net.core.somaxconn = 8192
net.core.netdev_max_backlog = 8192
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.neigh.default.gc_thresh1 = 1024
net.ipv4.neigh.default.gc_thresh2 = 4096
net.ipv4.neigh.default.gc_thresh3 = 8192
net.ipv6.neigh.default.gc_thresh1 = 1024
net.ipv6.neigh.default.gc_thresh2 = 4096
net.ipv6.neigh.default.gc_thresh3 = 8192
net.netfilter.nf_conntrack_max = 262144
net.netfilter.nf_conntrack_tcp_timeout_established = 86400
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
net.netfilter.nf_conntrack_generic_timeout = 120
fs.file-max = 2097152
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 524288
SYSCTL
  sysctl -p /etc/sysctl.d/99-incudal-node.conf >/dev/null 2>&1 || true
  echo "   swappiness=$(cat /proc/sys/vm/swappiness) conntrack_max=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo n/a) somaxconn=$(cat /proc/sys/net/core/somaxconn) file-max=$(cat /proc/sys/fs/file-max)"
else
  echo "   无 /etc/sysctl.d，跳过"
fi

# 透明大页：ZFS 场景用 madvise（always 会造成内存碎片与延迟抖动）
if [ -f /sys/kernel/mm/transparent_hugepage/enabled ]; then
  echo madvise > /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || true
  echo "   透明大页 = $(grep -oP '\[\K[^]]+' /sys/kernel/mm/transparent_hugepage/enabled)"
fi

# 补充屏蔽容器宿主机用不到的服务
for svc in blk-availability lvm2-monitor open-iscsi iscsid dm-event rpcbind nfs-common \
           ModemManager wpa_supplicant avahi-daemon cups cups-browsed snapd apport \
           unattended-upgrades apt-daily.service apt-daily.timer apt-daily-upgrade.service \
           apt-daily-upgrade.timer man-db.timer motd-news.timer fwupd-refresh.timer \
           e2scrub_all.timer sysstat.service sysstat-collect.timer sysstat-summary.timer; do
  systemctl mask "$svc" >/dev/null 2>&1 || true
done
echo "   已补充屏蔽容器宿主机无关服务"

echo "---- ⑧ 重启 incus 生效（容器不停，仅 API 中断数秒）----"
    systemctl daemon-reload
    systemctl try-restart incus >/dev/null 2>&1
    sleep 12
    systemctl is-active --quiet incus && echo "  incus 已重启 ✓" || echo "  ⚠ incus 未起来，请查 systemctl status incus"
  fi
fi

# 一次性回收可回收缓存，让效果立刻可见（缓存之后会被重新填充，属正常行为）
if [ "${SKIP_DROP_CACHES:-0}" != "1" ]; then
  sync
  echo 3 > /proc/sys/vm/drop_caches 2>/dev/null && echo "  已回收可回收缓存（pagecache/dentry/inode）"
fi

echo
echo "============ 优化后 ============"
free -m | sed -n '1,2p' | sed 's/^/  /'
printf "  incus.service    合计 %s MB（真实堆 anon %s MB）\n" \
  "$(mb "$(cg_bytes incus.service)")" "$(mb "$(cg_anon incus.service)")"
for s in incus-v6-guardian multipathd fwupd ModemManager systemd-journald; do
  v=$(cg_bytes "$s.service")
  [ "${v:-0}" -gt 0 ] && printf "  %-22s %s MB\n" "$s.service" "$(mb "$v")"
done
echo "  incusd 进程数: $(pgrep -c incusd 2>/dev/null || echo 0)（其中 forkproxy: $(pgrep -fc 'incusd forkproxy' 2>/dev/null || echo 0)）"
AFTER_RUN=$(count_running)
echo "  运行中容器: ${AFTER_RUN} 台（优化前 ${BEFORE_RUN} 台）"
if [ "$AFTER_RUN" -ge "$BEFORE_RUN" ]; then echo "  ✓ 容器全部在线"; else echo "  ⚠ 容器数变少，请检查 incus list"; fi
echo
echo "说明：Go 是渐进回收，内存下降需要几分钟到十几分钟才稳定。"
echo "回滚：rm -f /etc/systemd/system/incus.service.d/10-mem.conf && systemctl daemon-reload && systemctl try-restart incus"

# ============================================================
# ⑩ 内存回收：定时释放 slab 缓存（dentry + inode）
#    长跑节点内核 slab 会涨到几百 MB ~ 1GB+（SUnreclaim 部分
#    drop_caches 回收不掉，但 dentry/inode 这部分能回收）。
#    用 echo 2（只回收 dentry+inode，不动 pagecache）更安全。
# ============================================================
info "⑩ 内存回收定时器"
cat > /etc/systemd/system/incudal-cache-drop.service <<'EOF'
[Unit]
Description=Incudal periodic slab cache reclaim
After=network.target
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'sync; echo 2 > /proc/sys/vm/drop_caches'
EOF
cat > /etc/systemd/system/incudal-cache-drop.timer <<'EOF'
[Unit]
Description=Incudal periodic slab cache reclaim timer
[Timer]
OnBootSec=30min
OnUnitActiveSec=1h
AccuracySec=5min
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now incudal-cache-drop.timer >/dev/null 2>&1
systemctl is-active incudal-cache-drop.timer >/dev/null 2>&1 \
  && info "  ⑩ 定时回收已启用（每 6 小时一次，回收 dentry/inode）" \
  || warn "  ⑩ 定时回收启用失败"
