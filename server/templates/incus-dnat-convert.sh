#!/usr/bin/env bash
# ============================================================
#  Incudal 端口映射无损转换：forkproxy → 内核态 nftables DNAT
#
#  原理：
#    IPv4: ip  daddr <节点私网IP> tcp dport <端口> dnat to <容器IPv4>:<目标端口>
#    IPv6: ip6 daddr <节点公网v6> tcp dport <端口> dnat to [<容器IPv6>]:<目标端口>
#    → DNAT 在 prerouting 执行，早于 forkproxy 的本地监听 → 零中断接管
#    → 规则生效并验证后，proxy 设备即冗余，删除后 forkproxy 归零
#
#  容器 IPv6 用 incusbr0 的 ULA（fd42:.../64），节点天然可路由，无需改网卡
#
#  用法：
#    bash incus-dnat-convert.sh              # 预演（只打印将要做的事，不改动）
#    bash incus-dnat-convert.sh --apply      # 实际执行
#    bash incus-dnat-convert.sh --apply --yes # 不确认直接执行
#    INSTANCE=xxx bash incus-dnat-convert.sh --apply   # 只处理指定实例
# ============================================================
set -uo pipefail

APPLY=0; YES=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --yes) YES=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

NFT_TABLE_V4=incudal_dnat
NFT_TABLE_V6=incudal_dnat
RULES_FILE=/etc/incudal-dnat.nft
UNIT=/etc/systemd/system/incudal-dnat.service

command -v nft >/dev/null 2>&1 || { echo "✗ 没有 nft（nftables），退出"; exit 1; }
command -v incus >/dev/null 2>&1 || { echo "✗ 没有 incus，退出"; exit 1; }

# 节点私网 IPv4（云 NAT 后报文到达的地址）
PRIV4=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1)
# 节点公网 IPv6
HOST6=$(ip -6 addr show scope global 2>/dev/null | grep -oP 'inet6 \K[0-9a-f:]+' | grep -vE '^(fd|fe80)' | head -1)
echo "节点私网 IPv4 : ${PRIV4:-未检测到}"
echo "节点公网 IPv6 : ${HOST6:-未检测到}"
[ -n "$PRIV4" ] || { echo "✗ 检测不到私网 IPv4"; exit 1; }

# 收集：实例 -> 容器IPv4/IPv6
declare -A INST4 INST6
while IFS=$'\t' read -r name v4 v6; do
  [ -z "$name" ] && continue
  INST4["$name"]="$v4"; INST6["$name"]="$v6"
done < <(incus list --format=json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin)
for it in d:
    n=it.get("name","")
    a4="";a6=""
    for dev in (it.get("state") or {}).get("network",{}).values():
        for a in (dev.get("addresses") or []):
            if a.get("scope")!="global": continue
            if a.get("family")=="inet" and not a4: a4=a["address"]
            if a.get("family")=="inet6" and not a6 and not a["address"].startswith("fe80"): a6=a["address"]
    print(f"{n}\t{a4}\t{a6}")
' 2>/dev/null)

echo ""
echo "实例内网地址："
for k in "${!INST4[@]}"; do echo "  $k  v4=${INST4[$k]:-无}  v6=${INST6[$k]:-无}"; done
echo ""

# 生成规则
RULES_V4=(); RULES_V6=(); WORK=()
for inst in $(incus list -c n --format=csv 2>/dev/null); do
  [ -n "${INSTANCE:-}" ] && [ "$inst" != "$INSTANCE" ] && continue
  cfg=$(incus config show "$inst" 2>/dev/null) || continue
  # 逐个 proxy 设备解析 listen/connect
  echo "$cfg" | python3 -c '
import sys,re
txt=sys.stdin.read()
cur=None; d={}
for line in txt.splitlines():
    m=re.match(r"^  (\S+):\s*$", line)
    if m: cur=m.group(1); d[cur]={}; continue
    m=re.match(r"^    (\w+):\s*(.*)$", line)
    if m and cur: d[cur][m.group(1)]=m.group(2).strip()
for name,dev in d.items():
    if dev.get("type")!="proxy": continue
    lis=dev.get("listen",""); con=dev.get("connect","")
    def port(s):
        m=re.search(r":(\d+)\s*$", s or "")
        return m.group(1) if m else ""
    lp, cp = port(lis), port(con)
    if not lp or not cp: continue
    proto = "udp" if "udp" in (lis + con + name).lower() else "tcp"
    print(f"{name}\t{lp}\t{cp}\t{proto}\t{lis}\t{con}")
' | while IFS=$'\t' read -r dname lp cp proto lis con; do
      echo "DEV|$inst|$dname|$lp|$cp|$proto"
    done
done > /tmp/_dnat_devs.txt

echo "发现的 proxy 设备："
if [ ! -s /tmp/_dnat_devs.txt ]; then echo "  （无）"; else sed 's/^DEV|/  /' /tmp/_dnat_devs.txt; fi
echo ""

echo "将生成以下规则（已按 实例+协议+端口 去重）："
sort -u -t'|' -k2,2 -k4,4 -k6,6 /tmp/_dnat_devs.txt > /tmp/_dnat_uniq.txt
while IFS='|' read -r _ inst dname lp cp proto; do
  v4="${INST4[$inst]:-}"; v6="${INST6[$inst]:-}"
  if [ -n "$v4" ]; then
    echo "  ip  daddr $PRIV4 ${proto} dport $lp dnat to $v4:$cp        # $inst/$dname"
  else
    echo "  ⚠ $inst 没有内网 IPv4，跳过 v4 规则"
  fi
  if [ -n "$v6" ]; then
    echo "  ip6 daddr $HOST6 ${proto} dport $lp dnat to [$v6]:$cp      # $inst/$dname"
  else
    echo "  ⚠ $inst 没有 ULA IPv6（容器未启动？），跳过 v6 规则"
  fi
done < /tmp/_dnat_uniq.txt
echo ""

if [ "$APPLY" != "1" ]; then
  echo "（预演模式，未做任何改动。加 --apply 实际执行）"
  exit 0
fi

if [ "$YES" != "1" ]; then
  read -r -p "确认执行？(yes/no) " ans
  [ "$ans" = "yes" ] || { echo "已取消"; exit 0; }
fi

# ---- 执行（每个实例一张独立表，分批执行互不影响）----
sanitize() { echo "$1" | tr -c 'a-zA-Z0-9' '_'; }

echo "---- ① 建表（每实例独立）----"
for inst in $(cut -d'|' -f2 /tmp/_dnat_uniq.txt | sort -u); do
  t=$(sanitize "$inst")
  nft delete table ip  "incudal_${t}" 2>/dev/null || true
  nft delete table ip6 "incudal_${t}" 2>/dev/null || true
  nft add table ip  "incudal_${t}"
  nft add chain ip  "incudal_${t}" prerouting '{ type nat hook prerouting priority dstnat; policy accept; }'
  nft add table ip6 "incudal_${t}"
  nft add chain ip6 "incudal_${t}" prerouting '{ type nat hook prerouting priority dstnat; policy accept; }'
  echo "  ✓ 表 incudal_${t} 已建"
done

echo "---- ② 加规则（带计数器）----"
while IFS='|' read -r _ inst dname lp cp proto; do
  t=$(sanitize "$inst")
  v4="${INST4[$inst]:-}"; v6="${INST6[$inst]:-}"
  [ -n "$v4" ] && nft add rule ip  "incudal_${t}" prerouting ip  daddr "$PRIV4" "$proto" dport "$lp" counter dnat to "$v4:$cp" && echo "  ✓ $inst $proto/$lp → $v4:$cp"
  [ -n "$v6" ] && nft add rule ip6 "incudal_${t}" prerouting ip6 daddr "$HOST6" "$proto" dport "$lp" counter dnat to "[$v6]:$cp" && echo "  ✓ $inst $proto/$lp → [$v6]:$cp"
done < /tmp/_dnat_uniq.txt

echo "---- ③ 校验规则就位 ----"
ok=0; bad=0
while IFS='|' read -r _ inst dname lp cp proto; do
  t=$(sanitize "$inst")
  n=$(nft list table ip "incudal_${t}" 2>/dev/null | grep -c "$proto dport $lp ")
  m=$(nft list table ip6 "incudal_${t}" 2>/dev/null | grep -c "$proto dport $lp ")
  if [ "$n" -ge 1 ] || [ "$m" -ge 1 ]; then ok=$((ok+1)); echo "  ✓ $inst $proto/$lp (v4规则 $n / v6规则 $m)"; else bad=$((bad+1)); echo "  ✗ $inst $proto/$lp 规则缺失"; fi
done < /tmp/_dnat_uniq.txt
echo "  就位 $ok 条，异常 $bad 条"

if [ "$bad" -gt 0 ]; then
  echo "  ⚠ 有规则缺失，为安全起见【不删除任何 proxy 设备】，请检查后重跑"
  exit 1
fi

echo "---- ④ 删除对应的 proxy 设备（规则已覆盖 v4+v6 两族）----"
while IFS='|' read -r _ inst dname lp cp proto; do
  # 关键：实例没有 ULA IPv6 时无法生成 v6 规则，此时【保留】-v6 设备，否则会丢掉 IPv6 入口
  if [ -z "${INST6[$inst]:-}" ] && [[ "$dname" == *-v6 ]]; then
    echo "  ⏭ 保留 $inst/$dname（该实例无 ULA IPv6，删了会丢 IPv6 入口）"
    continue
  fi
  if incus config device remove "$inst" "$dname" >/dev/null 2>&1; then
    echo "  ✓ 已删除 $inst/$dname"
  else
    echo "  ✗ 删除 $inst/$dname 失败（功能不受影响，仅未省内存）"
  fi
done < /tmp/_dnat_devs.txt

echo "---- ⑤ 持久化（汇总所有 incudal_* 表）----"
{
  for t in $(nft list tables 2>/dev/null | grep -oP '^table ip \Kincudal_\S+' | sort -u); do nft list table ip "$t"; done
  for t in $(nft list tables 2>/dev/null | grep -oP '^table ip6 \Kincudal_\S+' | sort -u); do nft list table ip6 "$t"; done
} > "$RULES_FILE"
cat > "$UNIT" <<EOF
[Unit]
Description=Incudal 端口映射（内核态 nftables DNAT，替代 forkproxy）
After=network-online.target incus.service
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
# 先清掉所有 incudal_* 表再整体加载，避免 nft -f 合并导致重复
ExecStartPre=-/bin/sh -c 'nft list tables 2>/dev/null | grep -oP "^table (ip|ip6) \\Kincudal_\\S+" | sort -u | while read t; do nft delete table ip "\$t" 2>/dev/null; nft delete table ip6 "\$t" 2>/dev/null; done'
ExecStart=/usr/sbin/nft -f $RULES_FILE
ExecStop=-/bin/sh -c 'nft list tables 2>/dev/null | grep -oP "^table (ip|ip6) \\Kincudal_\\S+" | sort -u | while read t; do nft delete table ip "\$t" 2>/dev/null; nft delete table ip6 "\$t" 2>/dev/null; done'
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now incudal-dnat.service >/dev/null 2>&1
echo "  ✓ incudal-dnat.service ($(systemctl is-enabled incudal-dnat.service) / $(systemctl is-active incudal-dnat.service))"

echo ""
echo "---- ⑥ 结果 ----"
n=0; for p in $(pgrep incusd 2>/dev/null); do case "$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)" in *forkproxy*) n=$((n+1));; esac; done
echo "  forkproxy 进程: $n"
free -m | awk '/Mem:/{printf "  内存: 可用 %sMB | 已用 %sMB\n", $7, $3}'
echo "  容器: $(incus list -c n,s --format=csv | tr '\n' ' ')"
echo ""
echo "  回滚：systemctl disable --now incudal-dnat.service && nft delete table ip incudal_dnat; nft delete table ip6 incudal_dnat"
echo "        （proxy 设备需按面板重新创建）"
