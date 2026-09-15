#!/usr/bin/env bash
# =============================================================================
# finance-hub PM2 安全守卫（Linux / 服务器侧）
#
# 为什么服务器侧也需要守卫：
#   2026-09-14 的真实事故发生在阿里云服务器（Ubuntu 22.04, admin 用户）上，而不是
#   开发机。finance-hub 与 wrist-shell 等项目共用同一个 PM2 daemon；另一项目的部署
#   动作执行了 `pm2 delete all`，把 finance-hub 一并从 PM2 列表删除，随后的
#   `pm2 save` 又把「无 finance-hub」的列表固化为开机恢复列表。
#   ⇒ finance-hub 502 且不再开机自启，只能靠 deploy/health-check.sh 的 cron 兜底拉回。
#
# 本脚本做什么：
#   1) 拦掉批量/无差别目标：all、*、正则、纯数字进程 ID；
#   2) 默认只允许操作本项目白名单内的服务名，跨项目需显式 --allow-foreign；
#   3) 执行 `save` 前校验白名单服务仍在 PM2 列表中，防止把「服务已丢失」写死。
#
# 用法：
#   ./deploy/pm2-safe.sh <动作> [服务名] [--dry-run] [--allow-foreign]
#   动作：list status describe logs start stop restart reload delete save
#
# 正确示例：
#   ./deploy/pm2-safe.sh describe finance-hub
#   ./deploy/pm2-safe.sh stop     finance-hub --dry-run     # 演练，不执行
#   ./deploy/pm2-safe.sh restart  finance-hub
#
# 被拒绝的写法：
#   ./deploy/pm2-safe.sh delete all      ← 连带其它项目，禁用
#   ./deploy/pm2-safe.sh stop   '*'      ← 通配，禁用
#   ./deploy/pm2-safe.sh delete 3        ← 按进程 ID，ID 会漂移，禁用
#   pm2 kill                             ← 会杀掉整个 daemon，禁止（本脚本不提供该动作）
#
# 退出码：0 成功 / 2 参数被拒 / 3 环境缺失（pm2 不可用）/ 4 危险目标被拒
#         / 5 save 前置校验未通过 / 1 执行失败
#
# 注意：本文件必须保持 UTF-8 without BOM（带 BOM 会破坏 shebang 导致无法执行）。
# =============================================================================

# 故意不使用 set -e：本脚本用显式 exit code 表达拒绝原因，需要可预测的控制流。
set -uo pipefail

# ===== 本项目白名单：新增本项目服务时在此追加 =====
PROJECT_OWNED_SERVICES=("finance-hub")

ACTION="${1:-}"
NAME="${2:-}"
DRY_RUN=0
ALLOW_FOREIGN=0

# ===== 解析可选参数（顺序无关） =====
for arg in "$@"; do
  case "$arg" in
    --dry-run)       DRY_RUN=1 ;;
    --allow-foreign) ALLOW_FOREIGN=1 ;;
    -h|--help)       ACTION="__help__" ;;
  esac
done

usage() {
  cat <<'USAGE'
finance-hub PM2 安全守卫（服务器侧）—— 用法

  ./deploy/pm2-safe.sh <动作> [服务名] [--dry-run] [--allow-foreign]

  只读动作：list | status | describe | logs
  写动作　：start | stop | restart | reload | delete | save

  正确示例：
    ./deploy/pm2-safe.sh describe finance-hub
    ./deploy/pm2-safe.sh stop     finance-hub --dry-run    # 演练，不执行
    ./deploy/pm2-safe.sh restart  finance-hub

  被拒绝的写法：
    ./deploy/pm2-safe.sh delete all     ← 会连带干掉其它项目，禁用
    ./deploy/pm2-safe.sh stop   '*'     ← 通配，禁用
    ./deploy/pm2-safe.sh delete 3       ← 按进程 ID，ID 会漂移，禁用
    pm2 kill                            ← 会杀掉整个 daemon，禁用

  停止本项目服务的正确方式：pm2 stop finance-hub
  彻底移除本项目服务（谨慎）：pm2 delete finance-hub
USAGE
}

die() {
  # $1 = 消息, $2 = 退出码
  echo "" >&2
  echo "[拒绝] $1" >&2
  echo "" >&2
  exit "$2"
}

if [[ "$ACTION" == "__help__" || -z "$ACTION" ]]; then
  usage
  exit 0
fi

# ===== 1. 无条件拒绝的动作 =====
case "$ACTION" in
  kill)
    die "动作 kill 已禁用。pm2 kill 会杀掉整个 PM2 daemon，同机所有项目（含其它项目）的受管进程会全部停止。
需要停止本项目服务请使用：./deploy/pm2-safe.sh stop finance-hub
需要彻底移除本项目服务请使用：./deploy/pm2-safe.sh delete finance-hub" 4
    ;;
  list|status|describe|logs|start|stop|restart|reload|delete|save)
    ;;
  *)
    die "未知动作 '$ACTION'。可用动作：list status describe logs start stop restart reload delete save" 2
    ;;
esac

# ===== 2. 哪些动作必须有服务名（save 作用于整份列表，故不需要） =====
NEEDS_NAME=0
case "$ACTION" in
  describe|logs|start|stop|restart|reload|delete) NEEDS_NAME=1 ;;
esac

if [[ -z "$NAME" ]]; then
  if [[ "$NEEDS_NAME" == "1" ]]; then
    usage
    die "动作 '$ACTION' 必须显式指定服务名，不接受省略目标。" 2
  fi
else
  # 2a. 批量目标
  shopt -s nocasematch
  case "$NAME" in
    all|any|'*'|'.*'|--all|-a)
      die "目标 '$NAME' 表示「所有 PM2 进程」，已禁止。
本机多个项目共用同一个 PM2 daemon，批量操作会连带停掉或删除其它项目的服务，
并可能被 pm2 save 固化成开机状态（2026-09-14 finance-hub 事故即由此产生）。
请改用具体服务名，例如：./deploy/pm2-safe.sh $ACTION finance-hub" 4
      ;;
  esac
  shopt -u nocasematch

  # 2b. 通配符
  if [[ "$NAME" == *"*"* || "$NAME" == *"?"* || "$NAME" == *"["* ]]; then
    die "目标 '$NAME' 含通配符。本脚本只接受精确服务名，不接受模式匹配。" 4
  fi

  # 2c. 纯数字（PM2 进程 ID 会重新分配，按 ID 操作极易误伤）
  if [[ "$NAME" =~ ^[0-9]+$ ]]; then
    die "目标 '$NAME' 是 PM2 进程 ID。ID 会在进程增删后重新分配，按 ID 操作容易误伤其它项目；
请改用服务名，例如：./deploy/pm2-safe.sh $ACTION finance-hub" 4
  fi

  # 2d. 跨项目白名单
  if [[ "$ALLOW_FOREIGN" != "1" ]]; then
    IN_WHITELIST=0
    for svc in "${PROJECT_OWNED_SERVICES[@]}"; do
      if [[ "$NAME" == "$svc" ]]; then IN_WHITELIST=1; fi
    done
    if [[ "$IN_WHITELIST" != "1" ]]; then
      die "服务名 '$NAME' 不在本项目白名单内（白名单：${PROJECT_OWNED_SERVICES[*]}）。
这属于跨项目操作。确认影响面后，加 --allow-foreign 显式放行：
    ./deploy/pm2-safe.sh $ACTION $NAME --allow-foreign" 2
    fi
  fi
fi

# ===== 3. 确认 pm2 可用 =====
if ! command -v pm2 >/dev/null 2>&1; then
  echo "" >&2
  echo "[环境缺失] 当前环境找不到 pm2 命令。" >&2
  echo "  本脚本只是参数校验外壳，真正的 PM2 操作仍由 pm2 本体执行。" >&2
  echo "  未执行任何操作，未改动任何服务。" >&2
  echo "" >&2
  exit 3
fi

# ===== 4. save 前置校验 =====
if [[ "$ACTION" == "save" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[DryRun] 将先执行前置校验，确认以下服务仍在 PM2 列表中："
    for svc in "${PROJECT_OWNED_SERVICES[@]}"; do echo "    · $svc"; done
  else
    RAW="$(pm2 jlist 2>/dev/null || true)"
    if [[ -z "$RAW" || "$RAW" == "[]" ]]; then
      die "无法读取 PM2 进程列表（pm2 jlist 为空）。为避免把错误状态固化，已中止 save。" 5
    fi
    MISSING=""
    for svc in "${PROJECT_OWNED_SERVICES[@]}"; do
      if ! printf '%s' "$RAW" | grep -q "\"name\":\"$svc\""; then
        MISSING="$MISSING $svc"
      fi
    done
    if [[ -n "$MISSING" ]]; then
      die "pm2 save 已中止：以下本项目服务当前不在 PM2 列表中 ——$MISSING
此刻 save 会把「服务已丢失」的状态固化成开机恢复列表（正是 2026-09-14 事故的成因）。
请先恢复服务，再执行 save。在项目目录下执行：
    pm2 start \"node --experimental-sqlite server/index.js\" --name finance-hub
    ./deploy/pm2-safe.sh save" 5
    fi
    echo "[前置校验通过] 本项目服务均在 PM2 列表中。"
  fi
fi

# ===== 5. 组装并执行 =====
if [[ -n "$NAME" ]]; then
  RENDERED="pm2 $ACTION $NAME"
else
  RENDERED="pm2 $ACTION"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo ""
  echo "[DryRun] 校验通过，将要执行的命令为："
  echo "    $RENDERED"
  echo "  未真正执行，未改动任何服务。"
  echo ""
  exit 0
fi

echo "[执行] $RENDERED"
if [[ -n "$NAME" ]]; then
  pm2 "$ACTION" "$NAME"
else
  pm2 "$ACTION"
fi
CODE=$?
if [[ "$CODE" == "0" ]]; then
  echo "[完成] $RENDERED"
else
  echo "[失败] $RENDERED （退出码 $CODE）" >&2
fi
exit "$CODE"
