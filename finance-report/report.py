#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""消费月报导出器 — 读 SQLite 快照，导出单文件 HTML 月报。

只读（URI mode=ro）、离线、金额全程整数分运算、输出双击可开的单文件 HTML。

用法：
  .venv\\Scripts\\python.exe -X utf8 report.py --db <快照.db> --month 2026-08 --user <id|用户名> -o <输出.html>
      [--title TEXT] [--top N]

退出码：0 成功；2 参数/数据问题；1 运行失败。
"""

from __future__ import annotations

import argparse
import calendar
import html
import math
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# 口径常量（依据 finance-hub/server/index.js 源码 + demo.db 实测分布，见 README）
# ---------------------------------------------------------------------------

# 必要/非必要：与官方查询一致（server/index.js:589-591）——
# 仅支出行、且 transactions.grp IN ('必要','非必要')
NEEDED_GRP = ("必要", "非必要")
# 订阅命中关键词：分类名或备注命中任一（任务书 §5.7）
SUBSCRIPTION_KEYWORDS = ("订阅", "会员", "续费")

_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def yuan(cents: int) -> str:
    """整数分 → 显示用"元"字符串（只在显示层转换，不参与累加）。"""
    sign = "-" if cents < 0 else ""
    a = abs(cents)
    return f"{sign}{a // 100}.{a % 100:02d}"


def pct_x10_str(cur: int, prev: int) -> str:
    """环比百分比字符串（整数运算，一位小数）。prev 为 0 → '—'（不许 NaN/Infinity）。"""
    if prev == 0:
        return "—"
    delta = cur - prev
    x10 = abs(delta) * 1000 // abs(prev)
    s = f"{x10 // 10}.{x10 % 10}%"
    if delta > 0:
        return "+" + s
    if delta < 0:
        return "-" + s
    return "0.0%"


def share_x10_str(part: int, total: int) -> str:
    """占比字符串（整数运算）。total 为 0 → '—'。"""
    if total <= 0:
        return "—"
    x10 = part * 1000 // total
    return f"{x10 // 10}.{x10 % 10}%"


def prev_month(ym: str) -> str:
    """上一个月（处理跨年：2026-01 → 2025-12）。"""
    y, m = int(ym[:4]), int(ym[5:7])
    if m == 1:
        return f"{y - 1}-12"
    return f"{y}-{m - 1:02d}"


def days_in_month(ym: str) -> int:
    y, m = int(ym[:4]), int(ym[5:7])
    return calendar.monthrange(y, m)[1]


# ---------------------------------------------------------------------------
# 数据访问（只读）
# ---------------------------------------------------------------------------


def open_ro(db_path: Path) -> sqlite3.Connection:
    """只读打开；文件不存在直接报参数错误。"""
    if not db_path.is_file():
        raise FileNotFoundError(f"数据库文件不存在：{db_path}")
    uri = "file:" + str(db_path).replace("\\", "/").replace("?", "%3f").replace("#", "%23")
    conn = sqlite3.connect(uri + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def resolve_user(conn: sqlite3.Connection, user_arg: str) -> int:
    """--user 解析：纯数字优先按 users.id，否则按 username 精确匹配；users 表缺失时纯数字直接用。"""
    if table_exists(conn, "users"):
        if user_arg.isdigit():
            row = conn.execute("SELECT id FROM users WHERE id=?", (int(user_arg),)).fetchone()
            if row:
                return int(row["id"])
        row = conn.execute("SELECT id FROM users WHERE username=?", (user_arg,)).fetchone()
        if row:
            return int(row["id"])
        raise ValueError(f"用户不存在：{user_arg!r}（已查 users.id 与 users.username）")
    # 旧schema无 users 表：只接受数字 id
    if user_arg.isdigit():
        return int(user_arg)
    raise ValueError("库中没有 users 表，--user 只能是数字 id")


def resolve_month(conn: sqlite3.Connection, user_id: int, month_arg: str | None) -> str:
    if month_arg is None:
        row = conn.execute(
            "SELECT MAX(substr(date,1,7)) AS m FROM transactions WHERE user_id=?",
            (user_id,),
        ).fetchone()
        m = row["m"] if row else None
        if not m:
            raise ValueError(f"用户 {user_id} 在库中没有任何交易，无法确定缺省月份")
        return m
    if not _MONTH_RE.match(month_arg):
        raise ValueError(f"月份格式非法：{month_arg!r}（要求 YYYY-MM，如 2026-08）")
    return month_arg


def fetch_month_rows(conn: sqlite3.Connection, user_id: int, ym: str) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT t.id, t.date, t.amount_cents, t.category_id, t.note, t.remark,
               t.type, t.grp, t.channel,
               c.name AS cat_name, c.kind AS cat_kind
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = ? AND substr(t.date, 1, 7) = ?
        ORDER BY t.date, t.id
        """,
        (user_id, ym),
    ).fetchall()


# ---------------------------------------------------------------------------
# 统计（全部整数分；所有查询/聚合按 user 过滤）
# ---------------------------------------------------------------------------


def summarize(rows: list[sqlite3.Row]) -> dict:
    income = expense = 0
    count = 0
    days: set[str] = set()
    for r in rows:
        amt = r["amount_cents"]
        if r["type"] == "income":
            income += amt
        else:
            expense += amt
        count += 1
        days.add(r["date"])
    return {
        "income": income,
        "expense": expense,
        "balance": income - expense,
        "count": count,
        "days": len(days),
    }


def by_category(rows: list[sqlite3.Row]) -> tuple[list[dict], int]:
    """支出分类聚合（含悬空 category_id → 未分类）。返回 (列表, 未分类笔数)。"""
    cats: dict[str, dict] = {}
    uncategorized = 0
    for r in rows:
        if r["type"] != "expense":
            continue
        name = r["cat_name"] if r["cat_name"] else "未分类"
        if not r["cat_name"]:
            uncategorized += 1
        bucket = cats.setdefault(name, {"name": name, "cents": 0, "count": 0})
        bucket["cents"] += r["amount_cents"]
        bucket["count"] += 1
    out = sorted(cats.values(), key=lambda x: (-x["cents"], x["name"]))
    return out, uncategorized


def needed_split(rows: list[sqlite3.Row]) -> dict:
    """必要/非必要：仅支出行、grp IN ('必要','非必要')（与官方查询一致）。"""
    out = {"必要": 0, "非必要": 0, "未标注": 0}
    for r in rows:
        if r["type"] != "expense":
            continue
        grp = r["grp"]
        if grp in NEEDED_GRP:
            out[grp] += r["amount_cents"]
        else:
            out["未标注"] += r["amount_cents"]
    return out


def subscriptions(rows: list[dict]) -> list[dict]:
    """订阅类：支出行，且 分类名/备注/备注2 命中关键词（见 README 规则）。"""
    out = []
    for r in rows:
        if r["type"] != "expense":
            continue
        hay = " ".join(
            x for x in (r["cat_name"], r["note"], r["remark"]) if x
        )
        if any(k in hay for k in SUBSCRIPTION_KEYWORDS):
            out.append(dict(r))
    out.sort(key=lambda r: (-r["amount_cents"], r["date"]))
    return out


def top_expenses(rows: list[sqlite3.Row], n: int) -> list[sqlite3.Row]:
    exp = [r for r in rows if r["type"] == "expense"]
    exp.sort(key=lambda r: (-r["amount_cents"], r["date"], r["id"]))
    return exp[:n]


# ---------------------------------------------------------------------------
# HTML 渲染（单文件、内联、全转义）
# ---------------------------------------------------------------------------

CSS = """
:root { --bg:#f6f7fb; --card:#ffffff; --fg:#1f2430; --muted:#6b7280;
        --line:#e5e7eb; --green:#2e9e5b; --red:#d95555; --blue:#4a7fc1; }
* { box-sizing: border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
       font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; font-size:14px; }
.wrap { max-width: 960px; margin: 0 auto; }
h1 { font-size:20px; margin:0 0 4px; }
.meta { color:var(--muted); font-size:12px; margin-bottom:16px; line-height:1.7; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px;
        padding:16px; margin-bottom:16px; }
.card h2 { font-size:15px; margin:0 0 12px; }
.cards { display:flex; gap:12px; flex-wrap:wrap; }
.stat { flex:1 1 140px; background:var(--card); border:1px solid var(--line);
        border-radius:8px; padding:12px 14px; }
.stat .k { color:var(--muted); font-size:12px; }
.stat .v { font-size:20px; font-weight:600; margin-top:4px; }
.stat .s { color:var(--muted); font-size:11px; margin-top:2px; }
.pos { color:var(--green); } .neg { color:var(--red); }
table { width:100%; border-collapse:collapse; font-size:13px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
th { color:var(--muted); font-weight:500; font-size:12px; }
td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; }
.bar { display:flex; height:22px; border-radius:5px; overflow:hidden;
       background:#eef0f4; margin:8px 0; }
.bar span { display:block; height:100%; }
.legend { font-size:12px; color:var(--muted); line-height:1.9; }
.dot { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; }
.empty { color:var(--muted); padding:18px 0; text-align:center; }
.wraptext { overflow-wrap:anywhere; word-break:break-all; max-width:340px; }
.note { color:var(--muted); font-size:12px; line-height:1.8; margin-top:8px; }
.pie-wrap { display:flex; gap:20px; align-items:center; flex-wrap:wrap; }
.appendix { color:var(--muted); font-size:12px; line-height:1.9; }
"""

PIE_COLORS = [
    "#4a7fc1", "#d95555", "#2e9e5b", "#d9a03f", "#8a67c1", "#3fa8a8",
    "#c95f8a", "#7a8f3f", "#b07a4a", "#5f6bc4", "#c46a5f", "#5fa85f",
]


def esc(s) -> str:
    return html.escape(str(s if s is not None else ""), quote=True)


def pie_svg(slices: list[dict], size: int = 180) -> str:
    """手写 SVG 饼图。slices: [{name, cents}]，金额已降序。返回 <svg> 字符串。"""
    total = sum(s["cents"] for s in slices)
    if total <= 0:
        return '<div class="empty">本月无支出记录</div>'
    # 限制最多 12 个扇区，其余合并为"其他"（仅图上合并；表格列全量）
    shown = slices[:12]
    rest = slices[12:]
    if rest:
        shown = shown + [{
            "name": f"其他（{len(rest)} 类）",
            "cents": sum(s["cents"] for s in rest),
        }]
    cx = cy = size / 2
    r = size / 2 - 1
    parts = []
    angle_from = -90.0  # 从正上方开始
    for i, s in enumerate(shown):
        frac = s["cents"] / total
        angle = frac * 360.0
        color = PIE_COLORS[i % len(PIE_COLORS)]
        if angle >= 359.999:
            # 整圆：画一个完整 circle
            parts.append(
                f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}" />'
            )
            break
        a0 = angle_from
        a1 = angle_from + angle
        x0 = cx + r * math.cos(a0 * math.pi / 180.0)
        y0 = cy + r * math.sin(a0 * math.pi / 180.0)
        x1 = cx + r * math.cos(a1 * math.pi / 180.0)
        y1 = cy + r * math.sin(a1 * math.pi / 180.0)
        large = 1 if angle > 180 else 0
        parts.append(
            f'<path d="M {cx} {cy} L {x0:.2f} {y0:.2f} A {r} {r} 0 {large} 1 {x1:.2f} {y1:.2f} Z" '
            f'fill="{color}"><title>{esc(s["name"])} {share_x10_str(s["cents"], total)}</title></path>'
        )
        angle_from = a1
    return (
        f'<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}" role="img" '
        f'aria-label="分类占比饼图">{"".join(parts)}</svg>'
    )


def render_report(
    *,
    title: str,
    user_display: str,
    ym: str,
    gen_time: str,
    db_name: str,
    cur: dict,
    prev: dict | None,
    prev_ym: str | None,
    cats: list[dict],
    uncategorized: int,
    needed: dict,
    top_rows: list,
    top_n: int,
    subs: list[dict],
) -> str:
    """拼装单文件 HTML。所有动态文本经 esc()。"""

    def stat_card(k: str, v: str, sub: str = "", cls: str = "") -> str:
        return (
            f'<div class="stat"><div class="k">{esc(k)}</div>'
            f'<div class="v {cls}">{v}</div>'
            + (f'<div class="s">{sub}</div>' if sub else "")
            + "</div>"
        )

    # --- 总览卡 ---
    if cur["count"] == 0:
        overview = '<div class="card"><h2>总览</h2><div class="empty">本月无记录</div></div>'
    else:
        daily = (
            f"{yuan(cur['expense'] // cur['days'])}（按 {cur['days']} 个记账日）"
            if cur["days"] > 0
            else "—（0 个记账日）"
        )
        overview = (
            '<div class="cards">'
            + stat_card("总收入", yuan(cur["income"]), cls="pos")
            + stat_card("总支出", yuan(cur["expense"]), cls="neg")
            + stat_card("结余", yuan(cur["balance"]))
            + stat_card("笔数", str(cur["count"]))
            + stat_card("日均支出", daily)
            + "</div>"
        )
        overview = f'<div class="card"><h2>总览</h2>{overview}</div>'

    # --- 分类占比 ---
    if not cats:
        cat_block = '<div class="card"><h2>分类占比（支出）</h2><div class="empty">本月无记录</div></div>'
    else:
        total_exp = sum(c["cents"] for c in cats)
        rows = []
        legend = []
        for i, c in enumerate(cats):
            color = PIE_COLORS[i % len(PIE_COLORS)]
            rows.append(
                f"<tr><td><span class='dot' style='background:{color}'></span>{esc(c['name'])}</td>"
                f"<td class='num'>{yuan(c['cents'])}</td>"
                f"<td class='num'>{share_x10_str(c['cents'], total_exp)}</td>"
                f"<td class='num'>{c['count']}</td></tr>"
            )
            legend.append(
                f"<span><span class='dot' style='background:{color}'></span>{esc(c['name'])}</span>"
            )
        unc_note = (
            f'<div class="note">其中「未分类」{uncategorized} 笔（category_id 指向不存在的分类）。</div>'
            if uncategorized
            else ""
        )
        cat_block = (
            '<div class="card"><h2>分类占比（支出）</h2>'
            '<div class="pie-wrap">'
            + pie_svg(cats)
            + "<table><tr><th>分类</th><th class='num'>金额</th>"
            "<th class='num'>占比</th><th class='num'>笔数</th></tr>"
            + "".join(rows)
            + "</table></div>"
            + unc_note
            + "</div>"
        )

    # --- 必要 vs 非必要 ---
    nb_total = needed["必要"] + needed["非必要"]
    if nb_total <= 0 and needed["未标注"] == 0:
        needed_block = (
            '<div class="card"><h2>必要 vs 非必要</h2><div class="empty">本月无支出记录</div></div>'
        )
    else:
        w1 = (needed["必要"] * 100 // nb_total) if nb_total > 0 else 0
        w2 = (needed["非必要"] * 100 // nb_total) if nb_total > 0 else 0
        w1 = 100 - w2 if needed["非必要"] and nb_total > 0 else w1
        bar = (
            f'<div class="bar"><span style="width:{w1}%;background:var(--green)"></span>'
            f'<span style="width:{w2}%;background:var(--red)"></span></div>'
            if nb_total > 0
            else ""
        )
        needed_block = (
            '<div class="card"><h2>必要 vs 非必要</h2>' + bar +
            f'<div class="legend">'
            f'<span class="dot" style="background:var(--green)"></span>必要：{yuan(needed["必要"])}'
            f'（{share_x10_str(needed["必要"], nb_total)}）　'
            f'<span class="dot" style="background:var(--red)"></span>非必要：{yuan(needed["非必要"])}'
            f'（{share_x10_str(needed["非必要"], nb_total)}）　'
            f'未标注（grp 为空/其它，未参与比例）：{yuan(needed["未标注"])}'
            "</div>"
            '<div class="note">口径：仅支出交易，按 transactions.grp（与 finance-hub 官方查询一致：'
            "type='expense' AND grp IN ('必要','非必要')）。</div></div>"
        )

    # --- 环比 ---
    if prev is None:
        mom_block = (
            '<div class="card"><h2>环比上月'
            + (f"（{esc(prev_ym)}）" if prev_ym else "")
            + "</h2><div class='empty'>上月无数据，环比显示为 —（不显示 NaN/Infinity）</div></div>"
        )
    else:
        mom_rows = [
            ("总收入", cur["income"], prev["income"]),
            ("总支出", cur["expense"], prev["expense"]),
            ("结余", cur["balance"], prev["balance"]),
        ]
        trs = "".join(
            f"<tr><td>{esc(k)}</td><td class='num'>{yuan(c)}</td>"
            f"<td class='num'>{yuan(p)}</td><td class='num'>{pct_x10_str(c, p)}</td></tr>"
            for k, c, p in mom_rows
        )
        mom_block = (
            f'<div class="card"><h2>环比上月（{esc(prev_ym)}）</h2>'
            "<table><tr><th>项目</th><th class='num'>本月</th>"
            "<th class='num'>上月</th><th class='num'>环比</th></tr>"
            + trs
            + "</table><div class='note'>环比 =（本月 − 上月）/ 上月；上月为 0 时显示 —。</div></div>"
        )

    # --- Top N ---
    if not top_rows:
        top_block = (
            f'<div class="card"><h2>Top {top_n} 支出</h2><div class="empty">本月无记录</div></div>'
        )
    else:
        trs = "".join(
            f"<tr><td>{esc(r['date'])}</td><td>{esc(r['cat_name'] or '未分类')}</td>"
            f"<td class='wraptext'>{esc(r['note'] or '—')}</td>"
            f"<td class='num'>{yuan(r['amount_cents'])}</td></tr>"
            for r in top_rows
        )
        top_block = (
            f"<div class='card'><h2>Top {top_n} 支出</h2>"
            "<table><tr><th>日期</th><th>分类</th><th>备注</th><th class='num'>金额</th></tr>"
            + trs
            + "</table></div>"
        )

    # --- 订阅类 ---
    if not subs:
        sub_block = (
            '<div class="card"><h2>订阅类</h2><div class="empty">本月无订阅类记录</div></div>'
        )
    else:
        total = sum(r["amount_cents"] for r in subs)
        trs = "".join(
            f"<tr><td>{esc(r['date'])}</td><td>{esc(r['cat_name'] or '未分类')}</td>"
            f"<td class='wraptext'>{esc(r['note'] or '—')}</td>"
            f"<td class='num'>{yuan(r['amount_cents'])}</td></tr>"
            for r in subs
        )
        sub_block = (
            "<div class='card'><h2>订阅类</h2>"
            "<table><tr><th>日期</th><th>分类</th><th>备注</th><th class='num'>金额</th></tr>"
            + trs
            + f"</table><div class='note'>合计：{yuan(total)}。"
            f"命中规则：支出交易且 分类名/备注/备注2 含「{'」/'.join(SUBSCRIPTION_KEYWORDS)}」之一。</div></div>"
        )

    appendix = (
        '<div class="card"><h2>附录：未纳入本报告的维度</h2><div class="appendix">'
        "- transactions.share_kind：分摊备注（自由文本，如 \"÷2\"），不影响金额口径，未纳入统计。<br>"
        "- transactions.channel：支付渠道，本报告未按渠道拆分。<br>"
        "- items / item_events：大件物品台账，非流水，未纳入。<br>"
        "- vaults / vault_events：账户余额变动，非消费流水，未纳入。<br>"
        "- transactions.remark 单独字段已参与「订阅类」命中与附录说明，但不单独展示。<br>"
        "- settings / sessions：非账目数据，未纳入。"
        "</div></div>"
    )

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(title)}</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>{esc(title)}</h1>
  <div class="meta">
    用户：{esc(user_display)}　·　月份：{esc(ym)}　·　生成时间：{esc(gen_time)}　·　数据来源：{esc(db_name)}<br>
    金额单位：元（内部按整数分运算）；支出为正数显示。
  </div>
  {overview}
  {cat_block}
  {needed_block}
  {mom_block}
  {top_block}
  {sub_block}
  {appendix}
</div>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Year report (07b)
# ---------------------------------------------------------------------------

# 类别颜色：5 个主色循环
CATEGORY_BAR_COLORS = ["#22c55e", "#3b82f6", "#a78bfa", "#f59e0b", "#ec4899", "#14b8a6", "#f43f5e", "#0ea5e9", "#84cc16", "#d946ef"]


def _ym_list_year(year: str) -> list[str]:
    return [f"{year}-{m:02d}" for m in range(1, 13)]


def _ym_between(start: str, end: str) -> list[str]:
    """Inclusive list of YYYY-MM strings from start to end."""
    sy, sm = map(int, start.split("-"))
    ey, em = map(int, end.split("-"))
    out = []
    y, m = sy, sm
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def _summarize_with_kind(rows: list[sqlite3.Row]) -> dict:
    """扩展版汇总：包含 uncategorized / transfer（与 summarize 不冲突，因为独立函数）。"""
    income = expense = uncategorized = transfer = 0
    count = 0
    days: set[str] = set()
    for r in rows:
        amt = r["amount_cents"]
        kind = r["kind"] if "kind" in r.keys() else None
        if kind is None:
            # 没有 kind 字段（07 的旧接口）→ 退回 type
            kind = "income" if r["type"] == "income" else "expense"
        if kind == "income":
            income += amt
        elif kind == "expense":
            expense += amt
        elif kind == "transfer":
            transfer += amt
        else:
            uncategorized += amt
        count += 1
        days.add(r["date"])
    return {
        "income": income,
        "expense": expense,
        "count": count,
        "days": len(days),
        "uncategorized": uncategorized,
        "transfer": transfer,
        "ym": None,
    }


def build_year_report(conn, user_id: int, year: str) -> dict:
    """聚合指定年份的 12 个月数据 + 同比 + 分类年度榜。"""
    months = _ym_list_year(year)
    by_month: list[dict] = []
    for ym in months:
        rows = fetch_month_rows(conn, user_id, ym)
        s = _summarize_with_kind(rows)
        s["ym"] = ym
        by_month.append(s)
    totals = {
        "income": sum(m["income"] for m in by_month),
        "expense": sum(m["expense"] for m in by_month),
        "count": sum(m["count"] for m in by_month),
        "uncategorized": sum(m["uncategorized"] for m in by_month),
        "transfer": sum(m["transfer"] for m in by_month),
    }
    # 分类年度榜
    sql = """
        SELECT c.id, c.name, c.kind, c.grp,
               SUM(t.amount_cents) AS total_cents,
               COUNT(*) AS n_tx
          FROM transactions t
          JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = :uid AND substr(t.date,1,4) = :yr AND c.kind IN ('income','expense')
         GROUP BY c.id
         ORDER BY total_cents DESC
    """
    cat_rows = conn.execute(sql, {"uid": user_id, "yr": year}).fetchall()
    cats_year = [
        {
            "id": r["id"], "name": r["name"], "kind": r["kind"], "grp": r["grp"] or "",
            "total_cents": r["total_cents"] or 0, "n_tx": r["n_tx"] or 0,
        }
        for r in cat_rows
    ]
    # 去年聚合（用于同比）
    prev_year = str(int(year) - 1)
    prev_months = _ym_list_year(prev_year)
    by_month_prev: list[dict] = []
    for ym in prev_months:
        rows = fetch_month_rows(conn, user_id, ym)
        s = _summarize_with_kind(rows)
        by_month_prev.append(s)
    prev_totals = {
        "income": sum(m["income"] for m in by_month_prev),
        "expense": sum(m["expense"] for m in by_month_prev),
        "count": sum(m["count"] for m in by_month_prev),
        "uncategorized": sum(m["uncategorized"] for m in by_month_prev),
        "transfer": sum(m["transfer"] for m in by_month_prev),
    }
    # 环比：近 6 个月 vs 前 6 个月
    recent = by_month[6:]
    earlier = by_month[:6]
    mom = {
        "income_recent": sum(m["income"] for m in recent),
        "income_earlier": sum(m["income"] for m in earlier),
        "expense_recent": sum(m["expense"] for m in recent),
        "expense_earlier": sum(m["expense"] for m in earlier),
        "count_recent": sum(m["count"] for m in recent),
        "count_earlier": sum(m["count"] for m in earlier),
    }
    mom["avg_recent"] = mom["expense_recent"] // 6 if recent else 0
    mom["avg_earlier"] = mom["expense_earlier"] // 6 if earlier else 0
    return {
        "by_month": by_month,
        "by_month_prev": by_month_prev,
        "totals": totals,
        "prev_totals": prev_totals,
        "cats_year": cats_year,
        "mom": mom,
    }


def build_range_report(conn, user_id: int, start: str, end: str) -> dict:
    """区间报告：start..end (inclusive) 月度数据 + 区间汇总。"""
    months = _ym_between(start, end)
    by_month = []
    for ym in months:
        rows = fetch_month_rows(conn, user_id, ym)
        s = _summarize_with_kind(rows)
        s["ym"] = ym
        by_month.append(s)
    totals = {
        "income": sum(m["income"] for m in by_month),
        "expense": sum(m["expense"] for m in by_month),
        "count": sum(m["count"] for m in by_month),
        "uncategorized": sum(m["uncategorized"] for m in by_month),
        "transfer": sum(m["transfer"] for m in by_month),
    }
    # 分类汇总
    placeholders = ",".join([f":m{i}" for i in range(len(months))])
    sql = f"""
        SELECT c.id, c.name, c.kind, c.grp,
               SUM(t.amount_cents) AS total_cents,
               COUNT(*) AS n_tx
          FROM transactions t
          JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = :uid AND substr(t.date,1,7) IN ({placeholders}) AND c.kind IN ('income','expense')
         GROUP BY c.id
         ORDER BY total_cents DESC
    """
    params = {"uid": user_id}
    for i, m in enumerate(months):
        params[f"m{i}"] = m
    cat_rows = conn.execute(sql, params).fetchall()
    cats = [
        {
            "id": r["id"], "name": r["name"], "kind": r["kind"], "grp": r["grp"] or "",
            "total_cents": r["total_cents"] or 0, "n_tx": r["n_tx"] or 0,
        }
        for r in cat_rows
    ]
    return {
        "by_month": by_month,
        "totals": totals,
        "cats": cats,
        "months": months,
    }


def _bar_svg_year(by_month: list[dict]) -> str:
    """N 个月柱状图：纯 SVG，每月双柱（收入绿 / 支出红）。hover 用 <title> 提示。"""
    if not by_month:
        return '<svg width="100%" height="200"><text x="10" y="20" fill="#888">暂无数据</text></svg>'
    max_v = 1
    for m in by_month:
        max_v = max(max_v, m["income"], m["expense"])
    width = 720
    bar_area_h = 220
    pad_l, pad_r, pad_t, pad_b = 36, 16, 16, 36
    plot_w = width - pad_l - pad_r
    plot_h = bar_area_h - pad_t - pad_b
    n = len(by_month)
    group_w = plot_w / max(n, 1)
    bar_w = max(2, (group_w - 6) / 2)
    parts = [f'<svg viewBox="0 0 {width} {bar_area_h}" width="100%" height="{bar_area_h}" xmlns="http://www.w3.org/2000/svg" role="img">']
    for i in range(0, 4):
        y = pad_t + plot_h * i / 3
        v = int(max_v * (1 - i / 3))
        parts.append(f'<line x1="{pad_l}" y1="{y}" x2="{width - pad_r}" y2="{y}" stroke="#27272a" stroke-width="1"/>')
        parts.append(f'<text x="{pad_l - 4}" y="{y + 4}" text-anchor="end" fill="#a1a1aa" font-size="11">{v/100:.0f}</text>')
    for i, m in enumerate(by_month):
        gx = pad_l + group_w * i + 3
        ih = (m["income"] / max_v) * plot_h if max_v else 0
        ix = gx
        iy = pad_t + plot_h - ih
        parts.append(f'<rect x="{ix}" y="{iy}" width="{bar_w}" height="{ih}" fill="#22c55e"><title>{m["ym"]} 收入：{yuan(m["income"])}（{m["count"]} 笔）</title></rect>')
        eh = (m["expense"] / max_v) * plot_h if max_v else 0
        ex = gx + bar_w
        ey = pad_t + plot_h - eh
        parts.append(f'<rect x="{ex}" y="{ey}" width="{bar_w}" height="{eh}" fill="#ef4444"><title>{m["ym"]} 支出：{yuan(m["expense"])}（{m["count"]} 笔）</title></rect>')
        parts.append(f'<text x="{gx + bar_w}" y="{bar_area_h - 8}" text-anchor="middle" fill="#a1a1aa" font-size="10">{i+1}月</text>')
    parts.append('</svg>')
    return "".join(parts)


def _trend_svg(by_month: list[dict]) -> str:
    """每月净结余 = 收入 - 支出。一条折线。"""
    if not by_month:
        return '<svg width="100%" height="120"><text x="10" y="20" fill="#888">暂无数据</text></svg>'
    width = 720
    height = 120
    pad_l, pad_r, pad_t, pad_b = 36, 16, 12, 24
    plot_w = width - pad_l - pad_r
    plot_h = height - pad_t - pad_b
    n = len(by_month)
    net = [m["income"] - m["expense"] for m in by_month]
    min_v, max_v = min(net), max(net)
    if min_v == max_v:
        min_v -= 1; max_v += 1
    def x(i): return pad_l + plot_w * (i / max(n - 1, 1))
    def y(v): return pad_t + plot_h * (1 - (v - min_v) / (max_v - min_v))
    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" height="{height}" xmlns="http://www.w3.org/2000/svg" role="img">']
    # y axis lines
    for i in range(0, 4):
        yy = pad_t + plot_h * i / 3
        v = int(max_v * (1 - i / 3) + min_v * i / 3)
        parts.append(f'<line x1="{pad_l}" y1="{yy}" x2="{width - pad_r}" y2="{yy}" stroke="#27272a" stroke-width="1"/>')
        parts.append(f'<text x="{pad_l - 4}" y="{yy + 4}" text-anchor="end" fill="#a1a1aa" font-size="11">{v/100:.0f}</text>')
    if min_v <= 0 <= max_v:
        zy = y(0)
        parts.append(f'<line x1="{pad_l}" y1="{zy}" x2="{width - pad_r}" y2="{zy}" stroke="#71717a" stroke-dasharray="3,3" stroke-width="1"/>')
    pts = " ".join(f"{x(i):.1f},{y(net[i]):.1f}" for i in range(n))
    parts.append(f'<polyline points="{pts}" fill="none" stroke="#a78bfa" stroke-width="2"/>')
    for i, v in enumerate(net):
        parts.append(f'<circle cx="{x(i):.1f}" cy="{y(v):.1f}" r="3" fill="#a78bfa"><title>{by_month[i]["ym"]} 净结余：{yuan(v)}</title></circle>')
    for i in range(n):
        parts.append(f'<text x="{x(i):.1f}" y="{height - 6}" text-anchor="middle" fill="#a1a1aa" font-size="10">{i+1}</text>')
    parts.append('</svg>')
    return "".join(parts)


def _cat_bar_svg(cats: list[dict], max_w: int = 480) -> str:
    """分类年度榜横向条形（inline SVG 矩形，宽=占比）。"""
    if not cats:
        return '<div class="muted">无数据</div>'
    max_v = max(c["total_cents"] for c in cats) or 1
    parts = ['<div class="cat-bars">']
    for i, c in enumerate(cats[:10]):
        color = CATEGORY_BAR_COLORS[i % len(CATEGORY_BAR_COLORS)]
        w = max(2, int(max_w * c["total_cents"] / max_v))
        kind_class = "exp" if c["kind"] == "expense" else "inc"
        sign = "-" if c["kind"] == "expense" else "+"
        parts.append(
            f'<div class="cat-row" title="{c["name"]} · {c["n_tx"]} 笔">'
            f'<div class="cat-name">{esc(c["name"])}</div>'
            f'<svg width="{max_w}" height="18" class="cat-svg">'
            f'<rect x="0" y="2" width="{w}" height="14" fill="{color}" rx="3"/>'
            f'<text x="{w + 4}" y="14" fill="#d4d4d8" font-size="11">{sign}{yuan(c["total_cents"])} · {c["n_tx"]} 笔</text>'
            f'</svg>'
            f'</div>'
        )
    parts.append('</div>')
    return "".join(parts)


def _fmt_delta(cur: int, prev: int) -> str:
    if prev == 0:
        if cur == 0:
            return "±0%"
        return "+∞" if cur > 0 else "-∞"
    pct = (cur - prev) * 10000 // prev  # basis points * 100
    return f"{pct/100:+.2f}%"


def render_year_report(*, title: str, user_display: str, year: str, payload: dict, gen_time: str, db_name: str) -> str:
    by_month = payload["by_month"]
    totals = payload["totals"]
    prev_totals = payload["prev_totals"]
    cats_year = payload["cats_year"]
    mom = payload["mom"]

    # 月度小卡 HTML
    month_cards = []
    for m in by_month:
        month_cards.append(
            f'<div class="month-card"><div class="mc-ym">{m["ym"]}</div>'
            f'<div class="mc-row"><span class="mc-label">收入</span><span class="mc-val inc">+{yuan(m["income"])}</span></div>'
            f'<div class="mc-row"><span class="mc-label">支出</span><span class="mc-val exp">-{yuan(m["expense"])}</span></div>'
            f'<div class="mc-row"><span class="mc-label">笔数</span><span class="mc-val">{m["count"]}</span></div>'
            f'</div>'
        )
    month_cards_html = '<div class="month-grid">' + "".join(month_cards) + '</div>'

    bar_svg = _bar_svg_year(by_month)
    trend_svg = _trend_svg(by_month)
    cat_bars_html = _cat_bar_svg(cats_year)

    yoy_avail = bool(prev_totals["count"])
    yoy_html = ""
    if yoy_avail:
        yoy_html = (
            f'<table class="delta-table"><tr><th>指标</th><th>{int(year)-1}</th><th>{year}</th><th>同比</th></tr>'
            f'<tr><td>收入</td><td>{yuan(prev_totals["income"])}</td><td>{yuan(totals["income"])}</td><td class="{'up' if totals['income']>prev_totals['income'] else 'down'}">{_fmt_delta(totals["income"], prev_totals["income"])}</td></tr>'
            f'<tr><td>支出</td><td>{yuan(prev_totals["expense"])}</td><td>{yuan(totals["expense"])}</td><td class="{'up' if totals['expense']>prev_totals['expense'] else 'down'}">{_fmt_delta(totals["expense"], prev_totals["expense"])}</td></tr>'
            f'<tr><td>笔数</td><td>{prev_totals["count"]}</td><td>{totals["count"]}</td><td>{_fmt_delta(totals["count"], prev_totals["count"])}</td></tr>'
            f'<tr><td>单笔均值</td><td>{yuan(prev_totals["expense"]//prev_totals["count"]) if prev_totals["count"] else "-"}</td><td>{yuan(totals["expense"]//totals["count"]) if totals["count"] else "-"}</td><td>{_fmt_delta(totals["expense"]//max(totals["count"],1), prev_totals["expense"]//max(prev_totals["count"],1))}</td></tr>'
            f'</table>'
        )
    else:
        yoy_html = '<div class="muted">需要至少 2 年数据 — 去年暂无记录</div>'

    mom_html = (
        f'<table class="delta-table"><tr><th>指标</th><th>上半年</th><th>下半年</th><th>环比</th></tr>'
        f'<tr><td>收入</td><td>{yuan(mom["income_earlier"])}</td><td>{yuan(mom["income_recent"])}</td><td class="{'up' if mom['income_recent']>mom['income_earlier'] else 'down'}">{_fmt_delta(mom["income_recent"], mom["income_earlier"])}</td></tr>'
        f'<tr><td>支出</td><td>{yuan(mom["expense_earlier"])}</td><td>{yuan(mom["expense_recent"])}</td><td class="{'up' if mom['expense_recent']>mom['expense_earlier'] else 'down'}">{_fmt_delta(mom["expense_recent"], mom["expense_earlier"])}</td></tr>'
        f'<tr><td>笔数</td><td>{mom["count_earlier"]}</td><td>{mom["count_recent"]}</td><td>{_fmt_delta(mom["count_recent"], mom["count_earlier"])}</td></tr>'
        f'<tr><td>单笔均值</td><td>{yuan(mom["avg_earlier"]) if mom["count_earlier"] else "-"}</td><td>{yuan(mom["avg_recent"]) if mom["count_recent"] else "-"}</td><td>{_fmt_delta(mom["avg_recent"], mom["avg_earlier"])}</td></tr>'
        f'</table>'
    )

    uncounted_note = ""
    if totals["uncategorized"]:
        uncounted_note = f'<div class="warn-box">未分类交易 {totals["uncategorized"]} 笔未计入本报告</div>'
    if totals["transfer"]:
        uncounted_note += f'<div class="warn-box">transfer 类型 {totals["transfer"]} 笔未计入收支合计（仅作附录参考）</div>'

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>{esc(title)}</title>
<meta name="generator" content="report.py --year">
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: "Microsoft YaHei", -apple-system, sans-serif; background: #0e0e10; color: #e4e4e7; margin: 0; padding: 24px; line-height: 1.5; }}
  .wrap {{ max-width: 1080px; margin: 0 auto; }}
  h1 {{ font-size: 24px; margin: 0 0 4px; }}
  .meta {{ color: #a1a1aa; font-size: 12px; margin-bottom: 24px; }}
  .section {{ background: #18181b; border: 1px solid #2a2a30; border-radius: 12px; padding: 20px; margin-bottom: 16px; }}
  .section h2 {{ font-size: 16px; margin: 0 0 12px; color: #a78bfa; }}
  .totals {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }}
  .total-card {{ background: #27272a; border-radius: 8px; padding: 12px; text-align: center; }}
  .total-card .v {{ font-size: 22px; font-weight: 600; margin: 4px 0; }}
  .total-card .l {{ font-size: 11px; color: #a1a1aa; }}
  .inc {{ color: #22c55e; }}
  .exp {{ color: #ef4444; }}
  .month-grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }}
  .month-card {{ background: #27272a; border-radius: 6px; padding: 10px; font-size: 12px; }}
  .mc-ym {{ font-weight: 600; margin-bottom: 4px; }}
  .mc-row {{ display: flex; justify-content: space-between; margin: 2px 0; }}
  .mc-label {{ color: #a1a1aa; }}
  .mc-val {{ font-weight: 500; }}
  .delta-table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  .delta-table th, .delta-table td {{ padding: 8px 12px; border-bottom: 1px solid #2a2a30; text-align: right; }}
  .delta-table th {{ background: #27272a; color: #a1a1aa; font-weight: 500; text-align: center; }}
  .delta-table th:first-child, .delta-table td:first-child {{ text-align: left; }}
  .delta-table .up {{ color: #22c55e; }}
  .delta-table .down {{ color: #ef4444; }}
  .cat-row {{ display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 12px; }}
  .cat-name {{ width: 120px; color: #d4d4d8; }}
  .cat-svg {{ flex: 1; }}
  .muted {{ color: #71717a; font-style: italic; }}
  .warn-box {{ background: #451a1a; border: 1px solid #b91c1c; color: #fecaca; padding: 8px 12px; border-radius: 6px; font-size: 12px; margin: 8px 0; }}
  footer {{ color: #52525b; font-size: 11px; text-align: center; margin-top: 24px; }}
  @media (max-width: 700px) {{
    .totals {{ grid-template-columns: repeat(2, 1fr); }}
    .month-grid {{ grid-template-columns: repeat(2, 1fr); }}
  }}
  @media print {{
    body {{ background: white; color: black; }}
    .section {{ background: white; border: 1px solid #ddd; }}
    .total-card {{ background: #f4f4f5; }}
    .delta-table th {{ background: #f4f4f5; }}
    .month-card {{ background: #f4f4f5; }}
  }}
</style>
</head>
<body>
<div class="wrap">
  <h1>{esc(title)}</h1>
  <div class="meta">用户 {esc(user_display)} · 数据库 {esc(db_name)} · 生成于 {esc(gen_time)}</div>

  <div class="section">
    <h2>年度总览</h2>
    <div class="totals">
      <div class="total-card"><div class="l">总收入</div><div class="v inc">+{yuan(totals["income"])}</div><div class="l">{totals["count"]} 笔</div></div>
      <div class="total-card"><div class="l">总支出</div><div class="v exp">-{yuan(totals["expense"])}</div><div class="l">净结余 {yuan(totals["income"] - totals["expense"])}</div></div>
      <div class="total-card"><div class="l">总笔数</div><div class="v">{totals["count"]}</div><div class="l">月均 {totals["count"]//12 if totals["count"] else 0}</div></div>
      <div class="total-card"><div class="l">单笔均值</div><div class="v">{yuan(totals["expense"]//totals["count"]) if totals["count"] else "-"}</div><div class="l">支出 / 笔</div></div>
    </div>
    {uncounted_note}
  </div>

  <div class="section">
    <h2>12 月柱图（收入 vs 支出）</h2>
    {bar_svg}
    <div class="meta">绿=收入 · 红=支出 · 鼠标悬停查看当月数字</div>
  </div>

  <div class="section">
    <h2>月度净结余趋势</h2>
    {trend_svg}
  </div>

  <div class="section">
    <h2>分类年度榜 Top 10</h2>
    {cat_bars_html}
  </div>

  <div class="section">
    <h2>同比（今年 vs 去年）</h2>
    {yoy_html}
  </div>

  <div class="section">
    <h2>环比（下半年 vs 上半年）</h2>
    {mom_html}
  </div>

  <div class="section">
    <h2>月汇总卡片</h2>
    {month_cards_html}
  </div>

  <footer>report.py --year {year} · 单文件 HTML 输出 · 0 外部请求</footer>
</div>
</body>
</html>"""


def render_range_report(*, title: str, user_display: str, start: str, end: str, payload: dict, gen_time: str, db_name: str) -> str:
    by_month = payload["by_month"]
    totals = payload["totals"]
    months = payload["months"]
    cats = payload["cats"]
    cat_bars_html = _cat_bar_svg(cats)
    bar_svg = _bar_svg_year(by_month)  # 同一渲染器适用于任意 N 月
    trend_svg = _trend_svg(by_month)
    month_cards = []
    for m in by_month:
        month_cards.append(
            f'<div class="month-card"><div class="mc-ym">{m["ym"]}</div>'
            f'<div class="mc-row"><span class="mc-label">收入</span><span class="mc-val inc">+{yuan(m["income"])}</span></div>'
            f'<div class="mc-row"><span class="mc-label">支出</span><span class="mc-val exp">-{yuan(m["expense"])}</span></div>'
            f'<div class="mc-row"><span class="mc-label">笔数</span><span class="mc-val">{m["count"]}</span></div>'
            f'</div>'
        )
    month_cards_html = '<div class="month-grid">' + "".join(month_cards) + '</div>'

    # 半年对比：若区间为前 6 月 vs 后 6 月，可对比
    mom_html = ""
    if len(months) >= 6:
        mid = len(months) // 2
        first, second = by_month[:mid], by_month[mid:]
        fi = sum(m["income"] for m in first)
        fe = sum(m["expense"] for m in first)
        fc = sum(m["count"] for m in first)
        si = sum(m["income"] for m in second)
        se = sum(m["expense"] for m in second)
        sc = sum(m["count"] for m in second)
        mom_html = (
            f'<table class="delta-table"><tr><th>指标</th><th>{months[0]} .. {months[mid-1]}</th><th>{months[mid]} .. {months[-1]}</th><th>对比</th></tr>'
            f'<tr><td>收入</td><td>{yuan(fi)}</td><td>{yuan(si)}</td><td class="{'up' if si>fi else 'down'}">{_fmt_delta(si, fi)}</td></tr>'
            f'<tr><td>支出</td><td>{yuan(fe)}</td><td>{yuan(se)}</td><td class="{'up' if se>fe else 'down'}">{_fmt_delta(se, fe)}</td></tr>'
            f'<tr><td>笔数</td><td>{fc}</td><td>{sc}</td><td>{_fmt_delta(sc, fc)}</td></tr>'
            f'</table>'
        )

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>{esc(title)}</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: "Microsoft YaHei", -apple-system, sans-serif; background: #0e0e10; color: #e4e4e7; margin: 0; padding: 24px; line-height: 1.5; }}
  .wrap {{ max-width: 1080px; margin: 0 auto; }}
  h1 {{ font-size: 24px; margin: 0 0 4px; }}
  .meta {{ color: #a1a1aa; font-size: 12px; margin-bottom: 24px; }}
  .section {{ background: #18181b; border: 1px solid #2a2a30; border-radius: 12px; padding: 20px; margin-bottom: 16px; }}
  .section h2 {{ font-size: 16px; margin: 0 0 12px; color: #a78bfa; }}
  .totals {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }}
  .total-card {{ background: #27272a; border-radius: 8px; padding: 12px; text-align: center; }}
  .total-card .v {{ font-size: 22px; font-weight: 600; margin: 4px 0; }}
  .total-card .l {{ font-size: 11px; color: #a1a1aa; }}
  .inc {{ color: #22c55e; }} .exp {{ color: #ef4444; }}
  .month-grid {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }}
  .month-card {{ background: #27272a; border-radius: 6px; padding: 10px; font-size: 12px; }}
  .mc-ym {{ font-weight: 600; margin-bottom: 4px; }}
  .mc-row {{ display: flex; justify-content: space-between; margin: 2px 0; }}
  .mc-label {{ color: #a1a1aa; }}
  .mc-val {{ font-weight: 500; }}
  .delta-table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  .delta-table th, .delta-table td {{ padding: 8px 12px; border-bottom: 1px solid #2a2a30; text-align: right; }}
  .delta-table th {{ background: #27272a; color: #a1a1aa; font-weight: 500; text-align: center; }}
  .delta-table th:first-child, .delta-table td:first-child {{ text-align: left; }}
  .delta-table .up {{ color: #22c55e; }} .delta-table .down {{ color: #ef4444; }}
  .cat-row {{ display: flex; align-items: center; gap: 8px; margin: 4px 0; font-size: 12px; }}
  .cat-name {{ width: 120px; color: #d4d4d8; }}
  .cat-svg {{ flex: 1; }}
  footer {{ color: #52525b; font-size: 11px; text-align: center; margin-top: 24px; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>{esc(title)}</h1>
  <div class="meta">用户 {esc(user_display)} · 数据库 {esc(db_name)} · 区间 {esc(start)} 至 {esc(end)} ({len(months)} 个月) · 生成于 {esc(gen_time)}</div>

  <div class="section">
    <h2>区间总览</h2>
    <div class="totals">
      <div class="total-card"><div class="l">总收入</div><div class="v inc">+{yuan(totals["income"])}</div><div class="l">{totals["count"]} 笔</div></div>
      <div class="total-card"><div class="l">总支出</div><div class="v exp">-{yuan(totals["expense"])}</div><div class="l">净结余 {yuan(totals["income"] - totals["expense"])}</div></div>
      <div class="total-card"><div class="l">总笔数</div><div class="v">{totals["count"]}</div><div class="l">月均 {totals["count"]//len(months) if totals["count"] else 0}</div></div>
      <div class="total-card"><div class="l">单笔均值</div><div class="v">{yuan(totals["expense"]//totals["count"]) if totals["count"] else "-"}</div><div class="l">支出 / 笔</div></div>
    </div>
  </div>

  <div class="section">
    <h2>区间柱图</h2>
    {bar_svg}
  </div>

  <div class="section">
    <h2>净结余趋势</h2>
    {trend_svg}
  </div>

  {('<div class="section"><h2>分类汇总 Top 10</h2>' + cat_bars_html + '</div>') if cats else ''}
  {('<div class="section"><h2>区间对比</h2>' + mom_html + '</div>') if mom_html else ''}

  <div class="section">
    <h2>月汇总卡片</h2>
    {month_cards_html}
  </div>

  <footer>report.py --range {start}:{end}</footer>
</div>
</html>"""


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="report.py", description="消费月报 / 年报 导出器（只读）")
    ap.add_argument("--db", required=True, help="SQLite 快照路径（只读打开）")
    ap.add_argument("--month", default=None, help="YYYY-MM；缺省=该用户最大月份（与 --year/--range 互斥）")
    ap.add_argument("--year", default=None, help="YYYY；年报模式（与 --month/--range 互斥）")
    ap.add_argument("--range", default=None, help="YYYY-MM:YYYY-MM 区间；半年/任意范围模式（与 --month/--year 互斥）")
    ap.add_argument("--user", required=True, help="用户 id 或用户名（必填，多用户库按此过滤）")
    ap.add_argument("-o", "--out", required=True, help="输出 HTML 路径")
    ap.add_argument("--title", default=None, help="报告标题（缺省=消费月报 YYYY-MM / 年报 YYYY / 区间 YYYY-MM-YYYY-MM）")
    ap.add_argument("--top", type=int, default=10, help="Top N 支出条数（默认 10）")
    args = ap.parse_args(argv)

    # 参数校验（exit 2）
    if args.top < 0:
        print("[参数错误] --top 不能为负数", file=sys.stderr)
        return 2
    mode_count = sum(1 for v in (args.month, args.year, args.range) if v)
    if mode_count > 1:
        print("[参数错误] --month / --year / --range 互斥，只能用其一", file=sys.stderr)
        return 2
    if not _MONTH_RE.match(args.month or ""):
        if args.month is not None:
            print(
                f"[参数错误] 月份格式非法：{args.month!r}（要求 YYYY-MM，如 2026-08）",
                file=sys.stderr,
            )
            return 2
    if args.year and not re.match(r"^\d{4}$", args.year):
        print(f"[参数错误] --year 格式非法：{args.year!r}（要求 YYYY）", file=sys.stderr)
        return 2
    if args.range:
        m = re.match(r"^(\d{4}-\d{2}):(\d{4}-\d{2})$", args.range)
        if not m:
            print(f"[参数错误] --range 格式非法：{args.range!r}（要求 YYYY-MM:YYYY-MM）", file=sys.stderr)
            return 2
        if m.group(1) > m.group(2):
            print(f"[参数错误] --range 起始月份晚于结束月份", file=sys.stderr)
            return 2

    try:
        conn = open_ro(Path(args.db))
    except FileNotFoundError as e:
        print(f"[参数错误] {e}", file=sys.stderr)
        return 2
    except sqlite3.Error as e:
        print(f"[运行失败] 无法打开数据库（只读模式）：{e}", file=sys.stderr)
        return 1

    try:
        try:
            user_id = resolve_user(conn, args.user)
        except ValueError as e:
            print(f"[参数错误] {e}", file=sys.stderr)
            return 2

        # 用户显示名
        user_display = args.user
        if table_exists(conn, "users"):
            row = conn.execute("SELECT username FROM users WHERE id=?", (user_id,)).fetchone()
            if row and row["username"]:
                user_display = f"{row['username']}(id={user_id})"

        # --- 月报模式 ---
        if args.month is not None or (args.month is None and args.year is None and args.range is None):
            try:
                ym = resolve_month(conn, user_id, args.month)
            except ValueError as e:
                print(f"[参数错误] {e}", file=sys.stderr)
                return 2
            cur_rows = fetch_month_rows(conn, user_id, ym)
            prev_ym = prev_month(ym)
            prev_rows = fetch_month_rows(conn, user_id, prev_ym)
        else:
            cur_rows = []
            prev_ym = None
            prev_rows = []
            ym = None
    finally:
        conn.close()

    if args.month is not None or (args.month is None and args.year is None and args.range is None):
        # 月报模式
        cur = summarize(cur_rows)
        prev = summarize(prev_rows) if prev_rows else None
        cats, uncategorized = by_category(cur_rows)
        needed = needed_split(cur_rows)
        subs = subscriptions([dict(r) for r in cur_rows])
        top_rows = top_expenses(cur_rows, args.top)
        gen_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        db_name = Path(args.db).name
        title = args.title or f"消费月报 {ym}"
        html_text = render_report(
            title=title,
            user_display=user_display,
            ym=ym,
            gen_time=gen_time,
            db_name=db_name,
            cur=cur,
            prev=prev,
            prev_ym=prev_ym,
            cats=cats,
            uncategorized=uncategorized,
            needed=needed,
            top_rows=top_rows,
            top_n=args.top,
            subs=subs,
        )
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html_text, encoding="utf-8", newline="\n")
        print(
            f"[OK] {ym} 用户 {user_display}：收入 {yuan(cur['income'])} / 支出 {yuan(cur['expense'])} / "
            f"{cur['count']} 笔 → {out_path}"
        )
        return 0

    # 年报 / 区间模式
    # 重新开连接（被 finally 关闭了）
    conn2 = open_ro(Path(args.db))
    try:
        if args.year:
            payload = build_year_report(conn2, user_id, args.year)
            title = args.title or f"年报 {args.year}"
            html_text = render_year_report(
                title=title,
                user_display=user_display,
                year=args.year,
                payload=payload,
                gen_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                db_name=Path(args.db).name,
            )
            out_path = Path(args.out)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(html_text, encoding="utf-8", newline="\n")
            total = payload["totals"]
            print(
                f"[OK] 年报 {args.year} 用户 {user_display}：收入 {yuan(total['income'])} / 支出 {yuan(total['expense'])} / "
                f"{total['count']} 笔 → {out_path}"
            )
            return 0
        if args.range:
            start, end = args.range.split(":")
            payload = build_range_report(conn2, user_id, start, end)
            title = args.title or f"区间报告 {start} 至 {end}"
            html_text = render_range_report(
                title=title,
                user_display=user_display,
                start=start,
                end=end,
                payload=payload,
                gen_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                db_name=Path(args.db).name,
            )
            out_path = Path(args.out)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(html_text, encoding="utf-8", newline="\n")
            total = payload["totals"]
            print(
                f"[OK] 区间 {start}..{end} 用户 {user_display}：收入 {yuan(total['income'])} / 支出 {yuan(total['expense'])} / "
                f"{total['count']} 笔 → {out_path}"
            )
            return 0
    finally:
        conn2.close()
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # 兜底：运行失败 exit 1，打印可读原因
        print(f"[运行失败] {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)