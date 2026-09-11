#!/usr/bin/env bash
# E2E: let the agent actually operate the game.
#
# 职责: 一条命令跑起「LLM 决策 → 执行器施工 → 面板可看」的完整闭环，用于人工
#   验收与排障。默认用**本地 stub 当作 LLM**（无需 key、不花钱、可复现）；
#   加 --real 则用你在 dashboard/环境里配置的真实 provider。
# 事实来源: docs/AGENT-LOOP-AND-CONTROL.md（决策循环）、AGENTS.md §5.1（E2E 断言）。
# 禁止: 使用用户全局 OpenTTD 配置（一律隔离 data dir）。
#
# 用法:
#   scripts/e2e-agent.sh                 # stub LLM + --serve（页面控制开始/停止）
#   scripts/e2e-agent.sh --real          # 用已配置的真实 LLM（先配好再用）
#   scripts/e2e-agent.sh --watch         # 只观察（无 LLM，用于对比：Token 面板应为空）
#   scripts/e2e-agent.sh --port 9090     # 指定 dashboard 端口
set -euo pipefail

MODE="agent"
USE_REAL=0
WEB_PORT=8788
ADMIN_PORT=7801
GAME_PORT=7803
SECONDS_TO_RUN=180

while [ $# -gt 0 ]; do
  case "$1" in
    --real) USE_REAL=1; shift ;;
    --watch) MODE="watch"; shift ;;
    --port) WEB_PORT="$2"; shift 2 ;;
    --seconds) SECONDS_TO_RUN="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

DATA_DIR="${OPENTTD_DATA_DIR:-/tmp/openttd-agent-e2e}"
STUB_PORT=8899
STUB_PID=""
CLI_PID=""

cleanup() {
  echo ""
  echo "[e2e] cleaning up…"
  [ -n "$CLI_PID" ] && kill -INT "$CLI_PID" 2>/dev/null || true
  sleep 2
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  # NOTE: match the real binary path, never bare "openttd" - that also matches
  # our own repository path ("openttd-agent").
  pkill -f "OpenTTD.app/Contents/MacOS/openttd" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[e2e] data dir : $DATA_DIR"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

if [ "$MODE" = "agent" ] && [ "$USE_REAL" = "0" ]; then
  echo "[e2e] starting local LLM stub on :$STUB_PORT (no key needed)"
  pnpm exec tsx scripts/llm-stub.ts "$STUB_PORT" > "$DATA_DIR/stub.log" 2>&1 &
  STUB_PID=$!
  sleep 3
  # Point the app at the stub through llm.json, exactly like the dashboard would.
  cat > "$DATA_DIR/llm.json" <<JSON
{
  "providerId": "e2e-stub",
  "baseUrl": "http://127.0.0.1:$STUB_PORT/v1",
  "model": "stub",
  "api": "openai-completions",
  "apiKey": "sk-e2e-stub",
  "source": "custom"
}
JSON
  echo "[e2e] wrote $DATA_DIR/llm.json (custom endpoint → stub)"
fi

if [ "$MODE" = "agent" ] && [ "$USE_REAL" = "1" ]; then
  echo "[e2e] --real: using your configured provider (env LLM_* or $DATA_DIR/llm.json)"
fi

export OPENTTD_DATA_DIR="$DATA_DIR"
export OPENTTD_ADMIN_PORT="$ADMIN_PORT"
export OPENTTD_GAME_PORT="$GAME_PORT"

echo "[e2e] preflight:"
if [ "$MODE" = "watch" ]; then
  pnpm run cli --dry-run >/dev/null 2>&1 || true
  echo "  (watch = observation only: no LLM, so the token/step panels stay empty by design)"
  exec pnpm run cli --serve --web-port "$WEB_PORT"
else
  # --serve keeps the dashboard up and lets you start/stop/pause from the page.
  pnpm run cli --serve --web-port "$WEB_PORT" &
  CLI_PID=$!
  echo "  dashboard: http://127.0.0.1:$WEB_PORT/"
  echo "  → open it, then click «Start agent» (or POST /api/run/start)"
  echo "  → to confirm the agent is really driving:"
  echo "      curl -s http://127.0.0.1:$WEB_PORT/api/telemetry | head -c 400"
  wait "$CLI_PID"
fi
