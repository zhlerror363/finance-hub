# PM2 安全禁令（多项目共用 daemon）

> **本文件是本仓库的硬性运维约束，不是建议。任何部署、更新、排障动作都必须遵守。**
> 违反本禁令已在 2026-09-14 造成过一次真实线上故障（finance-hub 停机且不再开机自启）。

---

## 一、禁令条文

| 编号 | 禁止项 | 说明 |
|---|---|---|
| **P-1** | **禁止执行 `pm2 delete all`** | 会删除同一 PM2 daemon 下**所有项目**的进程，不止本项目。 |
| **P-2** | **禁止执行 `pm2 stop all` / `pm2 restart all` / `pm2 reload all`** | 会一并停止/重启同一 daemon 下**其它项目**的服务。 |
| **P-3** | **禁止执行 `pm2 kill`** | 会直接杀掉整个 PM2 daemon，同机全部受管进程停止。 |
| **P-4** | **禁止在没有服务名的情况下执行 `pm2 delete` / `pm2 stop`** | 缺少目标等于批量操作。 |
| **P-5** | **禁止按「进程 ID」操作**（如 `pm2 delete 3`） | PM2 的进程 ID 会在进程增删后重新分配，极易误伤其它项目。**一律用服务名。** |
| **P-6** | **禁止在服务缺失的状态下执行 `pm2 save`** | `save` 会把当前列表固化为「开机恢复列表」。若此刻列表已丢服务，等于把故障写死。 |

## 二、正确的停服 / 删除方式

```bash
# 停止本项目服务（保留定义，可随时 start 回来）—— 日常停服首选
pm2 stop finance-hub

# 彻底移除本项目服务（谨慎：之后需要重新 start 才会回来）
pm2 delete finance-hub

# 只重启本项目服务
pm2 restart finance-hub

# 查看状态（只读）
pm2 describe finance-hub
pm2 list
```

**统一要求：每条 PM2 命令都必须带明确的、具体的服务名。**

## 三、为什么会出这种事（2026-09-14 事故复盘）

| 项 | 内容 |
|---|---|
| 环境 | 阿里云轻量服务器，Ubuntu 22.04，用户 `admin` |
| 共用关系 | `finance-hub` 与 `wrist-shell`（以及其它项目）**共用同一个 PM2 daemon** |
| 触发动作 | 另一项目（`wrist-shell`）的部署动作，极可能执行了 `pm2 delete all` |
| 直接后果 | `finance-hub` 被一并从 PM2 进程列表**删除** |
| 二次后果 | 随后的 `pm2 save` 把「无 finance-hub」的列表**固化为开机恢复列表** |
| 最终表现 | 应用停止响应（502），且服务器重启后**不再自启** |
| 关键机制 | **PM2 只在「进程崩溃」时重启；进程从列表里消失，它管不着。** |

事故取证结论（来自项目运维记录）：服务器**并未重启**（`uptime -s` 显示更早的启动时间），
但 finance-hub 已从 PM2 列表消失 —— 说明是被外部 PM2 操作清除，而非崩溃。

## 四、根本解法：按项目隔离 PM2 daemon（强烈建议）

只要多项目共用**同一个 PM2 daemon**，`pm2 delete all` 就能一次性伤到所有项目；
守卫脚本只能防「用守卫的人」，防不了绕过脚本直接敲 `pm2` 的人。**结构性隔离才是根治手段。**

做法是给本项目一个独立的 `PM2_HOME`，使不同项目的 PM2 列表彼此不可见：

```bash
# 本项目专属 PM2_HOME（放进启动脚本 / systemd Environment 里，保持一致）
export PM2_HOME="$HOME/.pm2-financehub"

# 之后所有 pm2 命令只作用于本项目的列表，别的项目的 delete all 无法触及本项目
pm2 start "node --experimental-sqlite server/index.js" --name finance-hub
pm2 save
```

反之，其它项目也应各自设置**不同**的 `PM2_HOME`。这是唯一能让 `pm2 delete all` 失去跨项目破坏力的办法。

> **状态：未实施。** 本方案尚未在服务器上执行（修改 `PM2_HOME` 需要重启受管进程，
> 属于有中断风险的操作，需单独排期并做好回滚）。当前依赖第五节的守卫脚本 + 第六节的健康检查兜底。

## 五、守卫脚本（已提供）

本仓库提供两层守卫，逻辑一致：

| 平台 | 路径 | 说明 |
|---|---|---|
| Linux（服务器，**风险所在**） | `deploy/pm2-safe.sh` | 实际守护共用 daemon 的守卫，部署时随 `git pull` 一起下发 |
| Windows / PowerShell | `scripts/pm2-safe.ps1` | 开发机与 Windows 环境使用；需 UTF-8 with BOM 编码 |

守卫做三件事：

1. **拦掉批量 / 无差别目标**：`all`、`*`、正则、通配符、纯数字进程 ID 一律拒绝；
2. **跨项目白名单**：默认只允许操作本项目服务名（`finance-hub`），操作别的项目需显式加 `--allow-foreign` / `-AllowForeign`；
3. **`save` 前置校验**：执行 `save` 前确认本项目服务仍在 PM2 列表中，否则中止（防止把故障固化）。

### 用法（服务器侧）

```bash
./deploy/pm2-safe.sh describe finance-hub          # 只读，查看状态
./deploy/pm2-safe.sh stop     finance-hub --dry-run # 演练：只打印命令，不执行
./deploy/pm2-safe.sh restart  finance-hub           # 真正重启本项目
./deploy/pm2-safe.sh save                           # 带前置校验的 pm2 save
```

### 用法（Windows 侧）

```powershell
pwsh -File scripts\pm2-safe.ps1 -Action describe -Name finance-hub
pwsh -File scripts\pm2-safe.ps1 -Action stop     -Name finance-hub -DryRun
```

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | PM2 执行失败 |
| 2 | 参数被拒（缺服务名 / 不在白名单） |
| 3 | 环境缺失（找不到 `pm2`，未执行任何操作） |
| 4 | 危险目标被拒（`all` / 通配 / 进程 ID / `kill`） |
| 5 | `save` 前置校验未通过（服务不在 PM2 列表中） |

### 已验证行为（实测）

守卫脚本本身的行为已在开发机上实测通过（**全部为拒绝路径与假 pm2 垫片，未触碰任何真实 PM2 服务**）：

- `delete all` → 退出码 4，拒绝；`ALL` 大小写变体同样拒绝
- `kill` → 退出码 4，拒绝
- `stop '*'` / `stop ?` / `stop a*b` → 退出码 4，拒绝
- `delete 3`（进程 ID）→ 退出码 4，拒绝
- `restart wrist-relay`（跨项目）→ 退出码 2，提示需 `--allow-foreign`
- `restart`（缺服务名）→ 退出码 2，打印用法
- 假 pm2 垫片返回的列表**不含** `finance-hub` 时执行 `save` → 退出码 5，中止并给出恢复指引
- `--dry-run` → 退出码 0，只打印命令，未调用 pm2

> **未验证项**：守卫脚本尚未在服务器的真实 PM2 环境上运行过（真实 `pm2` 行为与假垫片可能有差异，
> 例如 `pm2 jlist` 的 JSON 字段格式）。首次上服务器使用前，请先跑一次 `--dry-run` 确认。

## 六、兜底：健康检查（已在线）

即使发生进程被清除，`deploy/health-check.sh` 会通过 cron 每分钟检查一次 3090：

```
* * * * * /home/admin/finance-hub/deploy/health-check.sh
```

逻辑：3090 不通 → 进程还在则 `restart`，进程已消失则 `start` → 再探测 → 成功则 `pm2 save`，日志写 `data/health.log`。

实测记录：删掉 PM2 进程后 **80 秒内自动恢复**（3090 恢复 HTTP 200）。

> ⚠️ 注意：健康检查是**兜底**，不是**许可**。它会自动 `pm2 start`，因此如果被删除的进程不止一个，
> 它只能救回本项目，其它项目仍需各自兜底。**不要因为"有兜底"就放松第一条禁令。**

## 七、部署与变更须知

- 服务器更新流程：`git pull` + 重启本项目服务。重启**必须带服务名**：
  ```bash
  cd /home/admin/finance-hub && git pull
  ./deploy/pm2-safe.sh restart finance-hub
  ```
- 新增本项目服务时，需同步把服务名加入两个守卫脚本的白名单（`PROJECT_OWNED_SERVICES` / `$ProjectOwnedServices`）。
- 任何要在服务器上执行的 PM2 批量命令，都应先在工作区讨论并记录理由 —— 目前没有已知的合法用例。

---

## 附：本文档的事实来源

| 内容 | 来源 | 本会话是否独立核实 |
|---|---|---|
| 09-14 事故经过、时间、根因、恢复记录 | 项目运维记录与历史日志 | ❌ 未核实（未访问服务器，按约束不接触线上 PM2） |
| `deploy/health-check.sh` 逻辑与 cron 配置 | 仓库内文件，已读取 | ✅ 已核实（`deploy/health-check.sh`） |
| 守卫脚本的拒绝逻辑与退出码 | 本会话实测 | ✅ 已核实（PS 5.1 解析 + 拒绝路径 + 假 pm2 垫片） |
| `PM2_HOME` 隔离方案 | 通用 PM2 机制推理 | ⚠️ 未在本机/服务器验证（本机未安装 PM2） |
| 本机 PM2 未安装 | 本会话实测 | ✅ 已核实（PATH 无 `pm2`、无 `~/.pm2`、全局 npm 无 pm2） |
