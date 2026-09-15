# 财务小管家 · Finance Hub

一款**多用户**的个人记账 Web 应用，支持 AI 智能记账与消费洞察，零第三方依赖，可自托管部署。

## ⚠️ 运维禁令：多项目共用 PM2（先读这一节）

> **本机（服务器）上 `finance-hub` 与其它项目共用同一个 PM2 daemon。**
> **严禁执行 `pm2 delete all`、`pm2 stop all`、`pm2 restart all`、`pm2 kill`。**
> 这些命令会**一并干掉其它项目的服务**，并且在 2026-09-14 已经造成过一次真实线上故障
> （finance-hub 被另一个项目的部署动作清除，随后 `pm2 save` 又把故障固化成开机状态）。

**正确的停服方式 —— 永远带具体服务名：**

```bash
pm2 stop finance-hub      # 停止（保留定义，可再 start）
pm2 restart finance-hub   # 重启
pm2 delete finance-hub    # 彻底移除（谨慎）
```

**更好：使用守卫脚本**（只接受具体服务名，明确拒绝 `all` / 通配 / 进程 ID）：

```bash
./deploy/pm2-safe.sh stop finance-hub --dry-run   # 服务器侧，先演练
pwsh -File scripts\pm2-safe.ps1 -Action stop -Name finance-hub -DryRun   # Windows 侧
```

完整禁令条文、事故复盘、`PM2_HOME` 隔离方案与实测记录见 **`deploy/PM2-安全禁令.md`**。

## 功能

- **多用户**：账号注册 / 登录 / 数据完全隔离；管理员可切换查看任意用户并分配 AI 额度。
- **记账**：支出 / 收入、大类 + 小类、交易方式（微信/支付宝/银行卡/现金）、必要 vs 非必要、分摊、备注独立字段。
- **资产**：金库（余额同步 / 回滚 / 拖拽排序）、物件（登记价值 / 产生效益 / 额外投入）。
- **看板**：分类占比（别味图 + 下钻细分）、收入分类、必要 vs 非必要、支出/收入趋势（同比 / 环比 / 近 30 天 / 自定义）。
- **AI 智能记账**：粘贴一段文本，AI 自动提取日期 / 金额 / 类别（DeepSeek 服务端代理）。
- **AI 消费洞察**：总结近几个月消费画像，给出个性化建议。
- **模拟数据模式**：独立的只读演示库（`data/demo.db`），所有用户共用，可完整体验功能且数据只读、不被污染。
- **响应式适配**：手机 / 平板 / 电脑 / 全屏 / 窗口。

## 技术栈

- **后端**：Node.js 内置 `node:http` + `node:sqlite`（**零第三方依赖**）。
- **前端**：原生 HTML / CSS / JS + 手写 SVG 图表。
- **AI**：DeepSeek API（服务端代理，key 存环境变量或 `data/ai-key.secret`，不落前端）。
- **鉴权**：Token（Bearer）会话 + 按用户数据隔离。

## 启动

```bash
# 需要 Node.js v22+
node --experimental-sqlite server/index.js
```

然后访问 `http://127.0.0.1:3090`。

> Windows 也提供 `start.bat` 双击启动。

## 目录

```text
finance-hub/
├─ server/index.js       # 后端（HTTP + SQLite + REST + AI 代理）
├─ web/                  # 前端（原生 JS + 手写 SVG）
├─ scripts/              # 导入工具等
│  └─ pm2-safe.ps1       # PM2 安全守卫（Windows：拒绝 all/通配/进程 ID）
├─ deploy/               # 部署资产
│  ├─ health-check.sh    # 健康检查（cron 每分钟，挂了自动拉起）
│  ├─ pm2-safe.sh        # PM2 安全守卫（Linux：拒绝 all/通配/进程 ID）
│  ├─ PM2-安全禁令.md     # ⚠️ 硬性运维禁令 + 事故复盘（必读）
│  ├─ nginx-financehub.conf
│  └─ clean-test-user.js
├─ data/                 # 运行时生成（用户库 finance.db + 演示库 demo.db），不入库
├─ docs/                 # 设计文档（不入库）
├─ start.bat             # Windows 启动
└─ README.md
```

## 数据与隐私

- 用户数据存 `data/finance.db`；演示数据存 `data/demo.db`（独立、只读）。
- 敏感文件（数据库、AI key、`.gitignore` 已排除 `data/`、`docs/`、`dist/`）不入库。
- 默认使用模拟数据模式，前往「设置」可退出。

## 路线图

- [x] 多用户 + 登录 + 数据隔离
- [x] AI 智能记账 + 消费洞察
- [x] 管理员额度管理
- [x] 模拟数据模式（独立只读演示库）
- [x] 响应式适配
