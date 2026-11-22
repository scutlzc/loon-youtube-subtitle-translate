#!/usr/bin/env bash
# 用法：./tools/check-key.sh            （安全模式，key 不回显、不进 shell 历史）
#      ./tools/check-key.sh sk-xxxx     （直接给 key）
# 作用：在电脑上验证 DeepSeek / 任意 OpenAI 兼容接口的 key 与模型是否可用，
#      排除「手机侧配置」这一层变量。
set -uo pipefail

BASE="${BASE:-https://api.deepseek.com/chat/completions}"
MODEL="${MODEL:-deepseek-flash}"
KEY="${1:-}"

if [ -z "$KEY" ]; then
  printf '把 key 直接粘到这里（不回显、不进历史）：'
  read -rs KEY
  echo
fi

KEY="$(printf '%s' "$KEY" | tr -d '[:space:]' | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' -e 's/^[Bb]earer //')"

echo "接口: $BASE"
echo "模型: $MODEL"
echo "key : ${KEY:0:6}…${KEY: -4}（长度 ${#KEY}）"
echo "----"

RESP="$(curl -sS -m 30 "$BASE" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"只回两个字：收到\"}]}" \
  -w $'\n%{http_code} %{time_total}' 2>&1)"

CODE="$(printf '%s' "$RESP" | tail -1 | awk '{print $1}')"
TIME="$(printf '%s' "$RESP" | tail -1 | awk '{print $2}')"
BODY="$(printf '%s' "$RESP" | sed '$d')"

echo "HTTP $CODE · ${TIME}s"
printf '%s\n' "$BODY" | head -c 600
echo
echo "----"
case "$CODE" in
  200) echo "✅ key 与模型都正常。手机上「授权失败」＝复制粘错了，重贴一次即可。" ;;
  401) echo "❌ key 无效：去 platform.deepseek.com → API keys 重新生成一个。" ;;
  402) echo "❌ 余额不足：充值后重试。" ;;
  404) echo "❌ 地址或模型名不对：确认 BASE 与 MODEL（老的 key 可能只认 deepseek-chat）。" ;;
  000) echo "❌ 连不上：网络/DNS/代理问题，与 key 无关。" ;;
  *)   echo "⚠️ 其他状态码，看上面原始返回。" ;;
esac
