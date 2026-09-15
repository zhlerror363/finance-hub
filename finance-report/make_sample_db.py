#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成虚构样例 SQLite 快照（自测用）——覆盖任务书 §6 全部 10 条边界 + 双用户。

所有数据均为占位虚构，不含任何真实账目。

用法：
  .venv\\Scripts\\python.exe -X utf8 make_sample_db.py <输出.db>
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

SCHEMA = """
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, password_hash TEXT DEFAULT '',
  ai_quota INTEGER DEFAULT 0, is_admin INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
  demo_mode INTEGER DEFAULT 0, last_insight TEXT DEFAULT '', last_login_at TEXT DEFAULT '',
  login_count INTEGER DEFAULT 0
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'expense',
  grp TEXT DEFAULT '必要', color TEXT DEFAULT '#7aa2c4', parent_id INTEGER DEFAULT NULL,
  sort_order INTEGER DEFAULT 0, user_id INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  category_id INTEGER NOT NULL, note TEXT DEFAULT '', share_kind TEXT DEFAULT '',
  type TEXT NOT NULL DEFAULT 'expense', channel TEXT DEFAULT '', grp TEXT DEFAULT '非必要',
  created_at TEXT DEFAULT (datetime('now')), remark TEXT DEFAULT '', user_id INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, amount_cents INTEGER DEFAULT 0,
  purchase_date TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
  sort_order INTEGER DEFAULT 0, user_id INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE item_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, delta_cents INTEGER DEFAULT 0,
  kind TEXT DEFAULT '', note TEXT DEFAULT '', event_date TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), user_id INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE vaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, balance_cents INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), user_id INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE vault_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vault_id INTEGER NOT NULL, delta_cents INTEGER DEFAULT 0,
  after_cents INTEGER DEFAULT 0, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
  user_id INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE settings (user_id INTEGER DEFAULT 0, key TEXT, value TEXT, PRIMARY KEY (user_id, key));
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
"""


def build(db_path: Path) -> None:
    if db_path.exists():
        db_path.unlink()
    conn = sqlite3.connect(str(db_path))
    conn.executescript(SCHEMA)

    # ---- 用户（2 个：隔离性验证用） ----
    conn.execute("INSERT INTO users (id, username, demo_mode) VALUES (1, 'demo_alice', 1)")
    conn.execute("INSERT INTO users (id, username, demo_mode) VALUES (2, 'demo_bob', 1)")

    # ---- 分类（user 1 / user 2 各自一套；悬空引用由 transactions 直接造） ----
    cats = [
        # (name, kind, grp, user_id)
        ("工资", "income", "", 1),
        ("副业", "income", "", 1),
        ("三餐", "expense", "必要", 1),
        ("交通", "expense", "必要", 1),
        ("日用品", "expense", "必要", 1),
        ("订阅", "expense", "非必要", 1),
        ("娱乐", "expense", "非必要", 1),
        ("数码", "expense", "非必要", 1),
        ("bob_专有分类", "expense", "非必要", 2),
    ]
    cat_ids: dict[tuple[str, int], int] = {}
    for name, kind, grp, uid in cats:
        cur = conn.execute(
            "INSERT INTO categories (name, kind, grp, user_id) VALUES (?,?,?,?)",
            (name, kind, grp, uid),
        )
        cat_ids[(name, uid)] = cur.lastrowid

    txs: list[tuple] = []  # (date, amount_cents, category_id, note, share_kind, type, channel, grp, remark, user_id)

    # ============ 用户 1：2026-08 主测月 ============
    # 收入
    txs.append(("2026-08-10", 800000, cat_ids[("工资", 1)], "占位工资", "", "income", "银行卡", "", "", 1))
    # 必要支出
    txs.append(("2026-08-01", 2500, cat_ids[("三餐", 1)], "占位早餐", "", "expense", "微信", "必要", "", 1))
    txs.append(("2026-08-01", 3000, cat_ids[("三餐", 1)], "占位午餐", "", "expense", "微信", "必要", "", 1))  # 同日多笔
    txs.append(("2026-08-02", 0, cat_ids[("交通", 1)], "占位零元（公交卡补签）", "", "expense", "现金", "必要", "", 1))  # 0 金额
    txs.append(("2026-08-05", 15900, cat_ids[("日用品", 1)], "占位纸巾 <洗衣液> & \"清洁剂\"", "", "expense", "微信", "必要", "", 1))  # HTML 特殊字符
    # 非必要 + 订阅命中（分类名命中）
    txs.append(("2026-08-03", 2500, cat_ids[("订阅", 1)], "占位视频网站", "", "expense", "支付宝", "非必要", "", 1))
    txs.append(("2026-08-15", 1800, cat_ids[("娱乐", 1)], "占位会员续费", "", "expense", "微信", "非必要", "", 1))  # 备注命中"会员/续费"
    txs.append(("2026-08-20", 30000, cat_ids[("数码", 1)], "占位键盘", "÷2", "expense", "微信", "非必要", "", 1))  # share_kind 示例
    # 退款：负数支出（冲减支出，口径见 README）
    txs.append(("2026-08-22", -5000, cat_ids[("数码", 1)], "占位退货退款", "", "expense", "微信", "非必要", "", 1))
    # 悬空分类 → 未分类
    txs.append(("2026-08-25", 6800, 99999, "占位悬空分类支出", "", "expense", "现金", "非必要", "", 1))
    # 超长备注（500 字）
    txs.append(("2026-08-28", 4500, cat_ids[("三餐", 1)], "占位超长备注" + "甲" * 492, "", "expense", "微信", "必要", "", 1))

    # ============ 用户 1：2026-07（上月，供环比） ============
    txs.append(("2026-07-10", 800000, cat_ids[("工资", 1)], "占位工资", "", "income", "银行卡", "", "", 1))
    txs.append(("2026-07-01", 3000, cat_ids[("三餐", 1)], "占位早餐", "", "expense", "微信", "必要", "", 1))
    txs.append(("2026-07-03", 2500, cat_ids[("订阅", 1)], "占位视频网站", "", "expense", "支付宝", "非必要", "", 1))

    # ============ 用户 1：2026-01 / 2025-12（跨年环比） ============
    txs.append(("2026-01-05", 500000, cat_ids[("工资", 1)], "占位跨年工资", "", "income", "银行卡", "", "", 1))
    txs.append(("2026-01-06", 2000, cat_ids[("三餐", 1)], "占位跨年早餐", "", "expense", "微信", "必要", "", 1))
    txs.append(("2025-12-20", 600000, cat_ids[("工资", 1)], "占位上月工资", "", "income", "银行卡", "", "", 1))
    txs.append(("2025-12-24", 8800, cat_ids[("娱乐", 1)], "占位年末娱乐", "", "expense", "微信", "非必要", "", 1))

    # ============ 用户 1：特殊月份形态 ============
    # 2026-03 只有收入；2026-04 只有支出；2026-05 空（无任何交易）
    txs.append(("2026-03-15", 300000, cat_ids[("副业", 1)], "占位副业到账", "", "income", "支付宝", "", "", 1))
    txs.append(("2026-04-02", 1200, cat_ids[("三餐", 1)], "占位四月餐费", "", "expense", "微信", "必要", "", 1))

    # ============ 用户 2（隔离性：同月不同数） ============
    txs.append(("2026-08-10", 999999, cat_ids[("工资", 1)], "bob 占位工资", "", "income", "银行卡", "", "", 2))
    txs.append(("2026-08-11", 12300, cat_ids[("bob_专有分类", 2)], "bob 占位支出", "", "expense", "现金", "非必要", "", 2))
    txs.append(("2026-07-11", 4500, cat_ids[("bob_专有分类", 2)], "bob 占位上月", "", "expense", "现金", "非必要", "", 2))

    conn.executemany(
        "INSERT INTO transactions (date, amount_cents, category_id, note, share_kind, type, channel, grp, remark, user_id)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        txs,
    )

    # ---- 附表（仅占位，报告不纳入） ----
    conn.execute(
        "INSERT INTO items (name, amount_cents, purchase_date, user_id) VALUES ('占位物品', 100000, '2026-08-20', 1)"
    )
    conn.execute(
        "INSERT INTO vaults (name, balance_cents, user_id) VALUES ('占位钱包', 50000, 1)"
    )

    conn.commit()
    conn.close()
    print(f"[OK] 样例库已生成：{db_path}（{db_path.stat().st_size} 字节，{len(txs)} 笔交易，全虚构）")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法：make_sample_db.py <输出.db>", file=sys.stderr)
        sys.exit(2)
    build(Path(sys.argv[1]))
