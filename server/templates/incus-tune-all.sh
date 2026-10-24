#!/usr/bin/env bash
# ============================================================
#  节点内存优化 · 批量铺开
#  在【能 SSH 到所有节点】的机器上执行（面板机 / 你的电脑）
#
#  用法：
#    bash incus-tune-all.sh                              # 全量（默认允许重启 incus，容器不停）
#    SKIP_INCUS_RESTART=1 bash incus-tune-all.sh         # 只写配置不重启（零影响，下次重启生效）
#    SSH_USER=ubuntu bash incus-tune-all.sh              # 指定 SSH 用户
#    SSH_KEY=~/.ssh/mykey bash incus-tune-all.sh         # 指定私钥
#    bash incus-tune-all.sh 1.2.3.4 5.6.7.8              # 只跑指定节点
#    BATCH=3 DELAY=30 bash incus-tune-all.sh             # 调整并发批与间隔
# ============================================================
set -uo pipefail

# 面板地址：优先环境变量，其次由调用方传入；默认留空时从 PANEL_URL 推导
PANEL_URL="${PANEL_URL:-https://your-panel.example.com}"
TUNE_URL="${TUNE_URL:-${PANEL_URL%/}/incus-tune.sh}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
BATCH="${BATCH:-4}"
DELAY="${DELAY:-25}"

if [ -z "$SSH_KEY" ]; then
  for k in /root/.ssh/id_ed25519 ~/.ssh/id_ed25519 /root/.ssh/id_rsa ~/.ssh/id_rsa; do
    [ -f "$k" ] && SSH_KEY="$k" && break
  done
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15"
[ -n "$SSH_KEY" ] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"

DEFAULT_NODES="${NODES:-}"   # 不内置任何节点地址；用参数 / NODES 环境变量 / NODES_FILE 传入
if [ $# -gt 0 ]; then
  NODES="$*"
elif [ -n "${NODES_FILE:-}" ] && [ -f "$NODES_FILE" ]; then
  NODES=$(grep -vE '^\s*(#|$)' "$NODES_FILE" | awk '{print $1}' | tr '\n' ' ')
else
  NODES="$DEFAULT_NODES"
fi

if [ -z "${NODES// /}" ]; then
  echo "用法: bash incus-tune-all.sh <ip> [ip...]"
  echo "  或: NODES_FILE=/path/nodes.txt bash incus-tune-all.sh"
  echo "  或: NODES=\"1.2.3.4 5.6.7.8\" bash incus-tune-all.sh"
  echo "  （节点列表不内置在脚本里）"
  exit 1
fi

echo "=============================================="
echo " 节点内存优化 · 批量铺开"
echo " 节点数 : $(echo $NODES | wc -w)   并发: ${BATCH} 台/批   间隔: ${DELAY}s"
echo " SSH    : ${SSH_USER}@  密钥: ${SSH_KEY:-<默认>}"
if [ "${SKIP_INCUS_RESTART:-0}" = "1" ]; then
  echo " 重启   : 跳过（只写配置，下次节点重启生效）"
else
  echo " 重启   : 允许（incus 重启，容器不停，仅 API 中断数秒）"
fi
echo "=============================================="

run_one() {
  local ip="$1" out rc
  out=$(timeout 300 ssh $SSH_OPTS "${SSH_USER}@${ip}" \
        "curl -sL '$TUNE_URL' | SKIP_INCUS_RESTART=${SKIP_INCUS_RESTART:-0} bash" 2>&1)
  rc=$?
  if [ $rc -ne 0 ] || [ -z "$out" ]; then
    echo "[✗] $ip  SSH 失败(rc=$rc) —— 密钥未授权或端口不通"
    return 1
  fi
  local summary
  summary=$(echo "$out" | grep -E '可用|已用|已屏蔽|已限额|GOMEMLIMIT|ZFS ARC|incus 已重启|跳过重启' | head -8 | sed 's/^ */      /')
  echo "[✓] $ip"
  echo "$summary"
  return 0
}

n=0; ok=0; fail=0; failed_list=""
for ip in $NODES; do
  run_one "$ip" && ok=$((ok+1)) || { fail=$((fail+1)); failed_list="$failed_list $ip"; }
  n=$((n+1))
  if [ $((n % BATCH)) -eq 0 ] && [ "$n" -lt "$(echo $NODES | wc -w)" ]; then
    echo "  …… 已完成 $n 台（成功 $ok / 失败 $fail），等 ${DELAY}s"
    sleep "$DELAY"
  fi
done

echo "=============================================="
echo " 完成：成功 $ok 台，失败 $fail 台"
[ -n "$failed_list" ] && echo " 失败节点：$failed_list"
echo " 失败通常是 SSH 密钥未授权，确认后单独重跑："
echo "   SSH_KEY=你的私钥 bash incus-tune-all.sh <失败节点IP>"
echo "=============================================="
