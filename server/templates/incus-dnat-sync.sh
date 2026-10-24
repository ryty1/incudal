#!/usr/bin/env bash
# ============================================================
#  Incudal 端口映射 reconciler v2（极简重写版）
#  把面板建的 v6 proxy 设备（forkproxy，每个约 11MB）换成内核态 nftables DNAT。
#  事实来源：① 实例配置 user.incudal.ports（面板写的期望映射）
#            ② 没有它 → 从 v4 设备兜底推导
#  没 ULA 的容器 → 直接清掉 v6 设备（dnat 只能同族，救不了）
# ============================================================
set -uo pipefail
command -v incus   >/dev/null 2>&1 || exit 0
command -v nft     >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

HOST6=$(ip -6 addr show scope global 2>/dev/null | grep -oP 'inet6 \K[0-9a-f:]+' | grep -vE '^(fd|fe80)' | head -1)
[ -n "$HOST6" ] || exit 0
export HOST6

incus query "/1.0/instances?recursion=2" 2>/dev/null | python3 -c '
import json, os, re, subprocess, sys

HOST6 = os.environ["HOST6"]

def sh(*a):
    try:
        return subprocess.run(a, capture_output=True, text=True, timeout=25)
    except Exception:
        return None

def nft(*a):
    r = sh("nft", *a)
    return (r.stdout or "") if (r and r.returncode == 0) else ""

def norm(s):
    return re.sub(r"counter packets \d+ bytes \d+", "counter", s)

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(data, list):
    sys.exit(0)

for it in data:
    n = it.get("name") or ""
    if not n:
        continue

    # ---- 容器的全局 IPv6 地址（ULA）----
    # 注：不能只用 state.network —— 实测部分容器在那里【不返回 v6 地址】，
    # 会导致误判为「无 ULA」而清掉 v6 设备。改用 incus exec 直接问容器。
    a6 = ""
    _r = sh("incus", "exec", n, "--", "ip", "-6", "addr", "show", "scope", "global")
    if _r and _r.returncode == 0:
        for _l in (_r.stdout or "").splitlines():
            _m = re.search(r"inet6\s+([0-9a-f:]+)/", _l)
            if _m and not _m.group(1).startswith("fe80"):
                a6 = _m.group(1); break
    if not a6:                      # 兜底：回退到 state.network
        for dv in ((it.get("state") or {}).get("network") or {}).values():
            for a in (dv.get("addresses") or []):
                if a.get("family") == "inet6" and a.get("scope") == "global" \
                   and not str(a.get("address", "")).startswith("fe80"):
                    a6 = a["address"]; break
            if a6:
                break

    devs = it.get("devices") or {}

    # ---- 没有 ULA：DNAT 无从谈起（只能同族），直接清掉 v6 设备 ----
    if not a6:
        for dn in list(devs):
            if re.match(r"^proxy-(tcp|udp)-\d+-v6$", dn):
                sh("incus", "config", "device", "remove", n, dn)
        continue

    # ---- 期望映射①：hint（proto:公网:内网）----
    hint = ((it.get("config") or {}).get("user.incudal.ports") or "").strip()
    des = {}
    for part in hint.split(","):
        f = part.strip().split(":")
        if len(f) == 3 and f[1].isdigit() and f[2].isdigit():
            des[(f[0].lower(), f[1])] = f[2]

    # ---- 期望映射②：从 v4 设备兜底推导 ----
    want = {}
    for dn, dv in devs.items():
        if dv.get("type") != "proxy":
            continue
        m = re.match(r"^proxy-(tcp|udp)-(\d+)$", dn)
        if not m:
            continue
        cm = re.search(r":(\d+)$", str(dv.get("connect") or ""))
        if cm:
            want[(m.group(1), m.group(2))] = cm.group(1)

    tgt = dict(des)
    for k, v in want.items():
        tgt.setdefault(k, v)
    if not tgt:
        continue

    t = "incudal_" + re.sub(r"[^A-Za-z0-9]", "_", n) + "_"
    cur = norm(nft("-a", "list", "table", "ip6", t))

    for (proto, lp), cp in sorted(tgt.items()):
        rule = "ip6 daddr %s %s dport %s counter dnat to [%s]:%s" % (HOST6, proto, lp, a6, cp)
        lines = [l for l in cur.splitlines()
                 if re.search(r"ip6 daddr \S+ %s dport %s counter " % (proto, lp), l)]
        if len(lines) == 1 and norm(lines[0]).strip() == rule.strip():
            continue
        sh("nft", "add", "table", "ip6", t)
        sh("nft", "add", "chain", "ip6", t, "prerouting",
           "{ type nat hook prerouting priority dstnat; policy accept; }")
        for l in lines:
            h = re.search(r"handle (\d+)", l)
            if h:
                sh("nft", "delete", "rule", "ip6", t, "prerouting", "handle", h.group(1))
        sh("nft", "add", "rule", "ip6", t, "prerouting",
           "ip6", "daddr", HOST6, proto, "dport", lp, "counter", "dnat", "to", "[%s]:%s" % (a6, cp))

    # 规则已建好 → 删掉该实例的 v6 proxy 设备（否则 forkproxy 会一直挂着占内存）
    for dn in list(devs):
        if re.match(r"^proxy-(tcp|udp)-\d+-v6$", dn):
            sh("incus", "config", "device", "remove", n, dn)
'
