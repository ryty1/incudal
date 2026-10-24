#!/usr/bin/env bash
# 一次性审计：用探活找出「DNAT 规则已建但容器服务其实不监听 IPv6」的映射
# （转换后这类端口在 v6 上不可达），恢复它们的 forkproxy 设备并删掉规则。
set -uo pipefail
HOST6=$(ip -6 addr show scope global 2>/dev/null | grep -oP 'inet6 \K[0-9a-f:]+' | grep -vE '^(fd|fe80)' | head -1)
[ -n "$HOST6" ] || exit 0
export HOST6
FIX=${FIX:-0}     # FIX=1 才真修，默认只报告

incus list --format=json 2>/dev/null | python3 -c '
import json, os, re, subprocess, sys
HOST6 = os.environ["HOST6"]; FIX = os.environ.get("FIX","0") == "1"
def run(*a):
    try: return subprocess.run(a, capture_output=True, text=True, timeout=25)
    except Exception: return None
def nft_out(*a):
    r = run("nft", *a); return r.stdout if r else ""
def tname(i): return "incudal_" + re.sub(r"[^a-zA-Z0-9]", "_", i) + "_"
def ipv6_ready(inst, proto, port):
    r = run("incus", "exec", inst, "--", "ss", "-lntu")
    if not r or r.returncode != 0: return None          # 探不到
    for line in r.stdout.splitlines():
        f = line.split()
        if len(f) < 5 or f[0] != proto: continue
        local = f[4]
        if local.rsplit(":",1)[-1] != str(port): continue
        host = local.rsplit(":",1)[0]
        if host.startswith("[") or host == "*": return True
    return False
try: data = json.load(sys.stdin)
except Exception: sys.exit(0)

bad = []
for it in data:
    n = it.get("name","")
    if not n: continue
    a6 = ""
    for dev in (it.get("state") or {}).get("network",{}).values():
        for a in (dev.get("addresses") or []):
            if a.get("scope")=="global" and a.get("family")=="inet6" and not a["address"].startswith("fe80"):
                a6 = a["address"]; break
        if a6: break
    if not a6: continue
    t = tname(n)
    raw = nft_out("-a","list","table","ip6",t)
    if not raw: continue
    for line in raw.splitlines():
        m = re.search(r"ip6 daddr \S+ (tcp|udp) dport (\d+) counter .* dnat to \[\S+\]:(\d+).*handle (\d+)", line)
        if not m: continue
        proto, lp, cp, h = m.group(1), m.group(2), m.group(3), m.group(4)
        ok = ipv6_ready(n, proto, int(cp))
        if ok is False:
            bad.append((n, proto, lp, cp, h, t))
print("  BAD=%d" % len(bad))
for n, proto, lp, cp, h, t in bad:
    print("    %-22s %s %s -> %s (规则 handle %s)" % (n, proto, lp, cp, h))
if FIX:
    for n, proto, lp, cp, h, t in bad:
        run("nft","delete","rule","ip6",t,"prerouting","handle",h)
        run("incus","config","device","add","proxy-%s-%s-v6" % (proto,lp),"proxy",
            "listen=%s:[%s]:%s" % (proto,HOST6,lp), "connect=%s:0.0.0.0:%s" % (proto,cp))
        print("    FIXED %s %s %s（已删规则 + 恢复 forkproxy）" % (n, proto, lp))
'
