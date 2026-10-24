#!/usr/bin/env bash
# ============================================================
#  Incudal ULA 守护（由 incudal-ula-guard.timer 周期调用）
#
#  作用：给【拿不到 IPv6 地址】的容器补一个静态 ULA。
#
#  为什么需要它：
#    reconciler 要把 v6 端口映射转成内核态 DNAT，前提是容器有 IPv6 地址
#    （DNAT 只能同族，v6 进来必须送到容器的 v6）。容器没 ULA 时 reconciler
#    会整台跳过 → 它的 v6 proxy 设备永远清不掉 → forkproxy 一直占内存。
#
#  为什么容器会拿不到 ULA（两种情况都见过）：
#    ① /etc/sysctl.conf 里 disable_ipv6=1 —— 客户自己或镜像把整个 IPv6 栈关了
#    ② accept_ra=0 —— 栈是开的但不接受 RA（容器用 ifupdown，interfaces 里
#       只有 IPv4 段，接口事件还会把 accept_ra 重置回 0）
#
#  做法：从宿主机直接给容器 NIC 配静态 ULA —— 绕开容器内所有 IPv6 配置，
#        不需要 RA，热应用不重启容器，也不动客户容器里的任何文件。
#        地址后缀用容器 IPv4 最后一段派生，保证唯一不撞。
# ============================================================
set -uo pipefail
command -v incus >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

PREFIX=$(incus network get incusbr0 ipv6.address 2>/dev/null | sed 's|/[0-9]*$||; s|::$||; s|:1$||')
[ -n "$PREFIX" ] || exit 0
export PREFIX

incus query "/1.0/instances?recursion=2" 2>/dev/null | python3 -c '
import json, os, re, subprocess, sys

PREFIX = os.environ["PREFIX"]

def run(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=25)
    except Exception:
        return None

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

for it in data:
    n = it.get("name", "")
    if not n:
        continue
    # 已有 global IPv6 → 跳过
    if any(a.get("scope") == "global" and a.get("family") == "inet6"
           and not a["address"].startswith("fe80")
           for dv in ((it.get("state") or {}).get("network") or {}).values()
           for a in (dv.get("addresses") or [])):
        continue
    dev = (it.get("devices") or {}).get("eth0") or {}
    if dev.get("ipv6.address"):
        continue                       # 已经配过静态地址，别重复配
    m = re.search(r"\.(\d+)$", str(dev.get("ipv4.address", "")))
    last = int(m.group(1)) if m else (abs(hash(n)) % 60000 + 1000)
    suf = "%x:%x" % (last // 256, last % 256)
    run("incus", "config", "device", "set", n, "eth0", "ipv6.address", "%s:%s/64" % (PREFIX, suf))
' 2>/dev/null || true
exit 0
