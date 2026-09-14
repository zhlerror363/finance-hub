#!/bin/bash
# finance-hub 健康检查：3090 不响应就自动拉起应用
# 部署：cron 每分钟执行一次  * * * * * /home/admin/finance-hub/deploy/health-check.sh
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

APP_DIR="/home/admin/finance-hub"
LOG="$APP_DIR/data/health.log"

# 3090 正常响应就退出
if curl -sf -o /dev/null --max-time 5 http://127.0.0.1:3090/; then
  exit 0
fi

cd "$APP_DIR" || exit 1

# 进程还在 → 重启；进程没了 → 重新 start
if pm2 describe finance-hub >/dev/null 2>&1; then
  pm2 restart finance-hub >/dev/null 2>&1
  ACTION="restart"
else
  pm2 start "node --experimental-sqlite server/index.js" --name finance-hub >/dev/null 2>&1
  ACTION="start"
fi

sleep 3
if curl -sf -o /dev/null --max-time 5 http://127.0.0.1:3090/; then
  pm2 save >/dev/null 2>&1
  echo "$(date '+%F %T') finance-hub 异常 → 已自动 $ACTION 恢复" >> "$LOG"
else
  echo "$(date '+%F %T') finance-hub 异常 → $ACTION 后仍不可用，需人工检查" >> "$LOG"
fi
