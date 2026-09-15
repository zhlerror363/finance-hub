# finance-report · 消费月报导出器

**本地离线**的 Python CLI：读一份 **SQLite 快照**（只读），导出**单文件 HTML 月报**。
双击 HTML 即可查看（内联 CSS/手写 SVG，无任何外部引用），方便归档与转发。

**只读保证**：连接用 `sqlite3.connect('file:<path>?mode=ro', uri=True)`；代码中无
`INSERT / UPDATE / DELETE / DROP / ALTER`。绝不接触线上服务与真实 `finance.db`。

---

## 用法

```bash
# 环境（一次性）
"C:\Users\lzhh\.local\bin\uv.exe" venv --python 3.12 .venv

# 生成虚构样例库（自测）
.venv\Scripts\python.exe -X utf8 make_sample_db.py tests\sample.db

# 导出月报
.venv\Scripts\python.exe -X utf8 report.py --db tests\sample.db --month 2026-08 --user 1 -o out.html
```

| 参数 | 说明 |
|---|---|
| `--db` | SQLite 快照路径（只读打开；文件必须存在） |
| `--month` | `YYYY-MM`；缺省 = 该用户库里最大月份。**与 `--year` / `--range` 互斥** |
| `--year` | `YYYY`；年报模式（12 月柱图 + 趋势线 + 分类榜 + 同比 + 环比 + 月汇总卡） |
| `--range` | `YYYY-MM:YYYY-MM`；区间模式（任意范围，半年/季度/单月都可） |
| `--user` | **必填**。纯数字优先按 `users.id` 匹配，否则按 `users.username` 精确匹配；库无 users 表时只接受数字 id |
| `-o` | 输出 HTML 路径 |
| `--title` | 报告标题（缺省 `消费月报 YYYY-MM` / `年报 YYYY` / `区间报告 ...`） |
| `--top` | Top N 支出条数（默认 10；**仅月报模式生效**） |

```bash
# 月报（07 原行为）
.venv\Scripts\python.exe -X utf8 report.py --db tests\sample.db --month 2026-08 --user demo_alice -o out.html

# 年报
.venv\Scripts\python.exe -X utf8 report.py --db tests\sample.db --year 2026 --user demo_alice -o year.html

# 半年区间
.venv\Scripts\python.exe -X utf8 report.py --db tests\sample.db --range 2026-01:2026-06 --user demo_alice -o h1.html
```

退出码：`0` 成功；`2` 参数/数据问题（路径不存在、月份非法、用户不存在、该用户无交易）；`1` 运行失败。失败均打印可读原因。

依赖：**仅 Python 3.12 标准库**（sqlite3 内置），`requirements.txt` 无第三方包。

---

## 口径观察（基于 finance-hub 源码 + demo.db 只读实测，非猜测）

> 观察方法：读 `finance-hub/server/index.js` 的建表语句与查询逻辑（只读源码，
> 未改任何文件），并用 `demo.db`（应用自带的**随机演示数据**，非真实账本）以
> `mode=ro` 打印各列取值分布。真实 `finance.db` 与线上部署**从未接触**。

| 列 | 实测/源码依据 | 本工具的口径 |
|---|---|---|
| `transactions.type` | `expense` / `income` 二值（demo.db：expense 899、income 17） | `type='income'` 记收入，其余按支出 |
| `transactions.date` | `YYYY-MM-DD` 文本（源码 `${ym}-${pad(day)}`；demo.db 实测一致） | `substr(date,1,7)` 按月过滤 |
| `amount_cents` 符号 | **恒为正**，符号由 type 推导（源码 L461：`(type==='income'?1:-1)*amount_cents`；demo.db 0 笔 ≤0） | 按原值符号参与该 type 合计；**负数支出视为退款冲减**（样例含 -50.00 验证） |
| `categories.kind` | `expense` / `income`（建表 DEFAULT 'expense'） | 仅用于口径说明；统计以 `transactions.type` 为准 |
| `categories.grp` | `必要` / `非必要` / `''`（收入类为空） | 不直接使用（用 transactions.grp 快照） |
| `transactions.grp` | 支出行 = `必要`/`非必要`；收入行可能是噪声值（demo.db 里工资行的 grp='必要'） | **必要/非必要仅统计支出行**，且 `grp IN ('必要','非必要')`——与官方查询逐字一致（server/index.js L589-591），落入其它值的计入"未标注"不参与比例 |
| `transactions.share_kind` | 自由文本分摊备注，源码注释 `-- e.g. "÷2"`；demo.db 916/916 全空 | **未纳入统计**（不影响金额），附录说明 |

---

## 报告区块

1. 抬头（用户 / 月份 / 生成时间 / 来源文件名——只取文件名不含路径）
2. 总览卡（总收入 / 总支出 / 结余 / 笔数 / **日均支出**——按当月有任意记账的天数，天数写明）
3. 分类占比（手写 SVG 饼图 + 降序表格；悬空 category_id → 「未分类」并计数）
4. 必要 vs 非必要（比例条 + 金额，口径见上）
5. 环比上月（总收入/总支出/结余；上月无数据或为 0 → 显示 "—"，绝不出现 NaN/Infinity；跨年自动处理，2026-01 → 2025-12）
6. Top N 支出（备注空显示 "—"）
7. 订阅类：**支出**交易且（分类名 / note / remark）含「订阅」「会员」「续费」任一关键词
8. 附录（未纳入维度与原因）

金额全程**整数分**累加，仅在显示层转"元"（`yuan()`：整除+取余，无浮点累加）。
占比/环比用整数运算（`*1000//total` 取一位小数）。

---

## 已知限制

- 饼图最多画 12 个扇区，更多分类在图上合并为"其他"（表格仍列全量）
- `--month` 缺省取"该用户最大月份"（不是全库最大）
- 库缺少 `transactions` / `categories` 表时报运行失败（exit 1）
- HTML 为纯静态（无 JS 交互），不支持钻取——那是 finance-hub 的事
