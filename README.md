# 财务小管家 · Finance Hub

一款**多用户**的个人记账 Web 应用，支持 AI 智能记账与消费洞察，零第三方依赖，可自托管部署。

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
├─ data/                 # 运行时生成（用户库 finance.db + 演示库 demo.db），不入库
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
