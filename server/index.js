'use strict';

// ===== 财务小管家 · 后端（零依赖，Node 内置模块）=====
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'finance.db');
const PORT = 3090;

// v3 阶段四：AI（DeepSeek，项目专用 key）——优先读环境变量 DEEPSEEK_API_KEY，
// 否则读 data/ai-key.secret（gitignore 保护，不进 git），两者都存进内存，绝不落前端/日志。
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || (() => {
  try {
    const f = path.join(DATA_DIR, 'ai-key.secret');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
  } catch { return ''; }
})()).trim();
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';

// --- 数据目录 & 数据库 ---
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// v5 独立只读演示库（所有用户模拟模式共用，只读，不被更改）
const DEMO_DB_PATH = path.join(DATA_DIR, 'demo.db');
let demoDb = null;
let activeDb = db; // 查询目标：普通模式=用户库(db)，模拟模式=demoDb(只读)

initSchema();
migrate();
seedIfEmpty();
assignLegacyData();
openDemoDb(); // v5 演示库启动即生成（常驻只读库，所有用户模拟模式共用）

function openDemoDb() {
  if (demoDb) return demoDb;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  demoDb = new DatabaseSync(DEMO_DB_PATH);
  demoDb.exec('PRAGMA journal_mode = WAL;');
  demoDb.exec(`
    CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'expense', grp TEXT DEFAULT '必要', color TEXT DEFAULT '#7aa2c4', parent_id INTEGER DEFAULT NULL, sort_order INTEGER DEFAULT 0, user_id INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, amount_cents INTEGER NOT NULL, category_id INTEGER NOT NULL, note TEXT DEFAULT '', remark TEXT DEFAULT '', share_kind TEXT DEFAULT '', type TEXT NOT NULL DEFAULT 'expense', channel TEXT DEFAULT '', grp TEXT DEFAULT '非必要', created_at TEXT DEFAULT (datetime('now')), user_id INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE IF NOT EXISTS vaults (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, balance_cents INTEGER NOT NULL DEFAULT 0, sort_order INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), user_id INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, amount_cents INTEGER NOT NULL, purchase_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), sort_order INTEGER DEFAULT 0, user_id INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE IF NOT EXISTS vault_events (id INTEGER PRIMARY KEY AUTOINCREMENT, vault_id INTEGER NOT NULL, delta_cents INTEGER NOT NULL, after_cents INTEGER NOT NULL, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), user_id INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE IF NOT EXISTS item_events (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, delta_cents INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT DEFAULT '', event_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), user_id INTEGER NOT NULL DEFAULT -1);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX IF NOT EXISTS idx_demo_txn_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_demo_txn_cat ON transactions(category_id);
    CREATE INDEX IF NOT EXISTS idx_demo_ve_vault ON vault_events(vault_id);
  `);
  seedDemoDb();
}
function seedDemoDb() {
  // 若已填充则不重复
  if (demoDb.prepare('SELECT COUNT(*) AS n FROM categories').get().n > 0) return;
  const demoUser = -1;
  // 分类（大类 + 小类）
  const catDefs = [
    { kind: 'expense', name: '正餐', color: '#d97a6c', kids: ['早餐', '午餐', '晚餐'] },
    { kind: 'expense', name: '交通', color: '#7aa2c4', kids: ['地铁', '公交', '打车'] },
    { kind: 'expense', name: '购物', color: '#c98fd6', kids: ['日用品', '服饰'] },
    { kind: 'expense', name: '数码', color: '#7a7fd6', kids: ['手机', '耳机'] },
    { kind: 'expense', name: '娱乐', color: '#c4b77a', kids: ['电影', '游戏'] },
    { kind: 'expense', name: '零食饮料', color: '#e0a45e', kids: ['奶茶', '零食'] },
    { kind: 'expense', name: '订阅', color: '#6ec4c4', kids: ['会员', '软件'] },
    { kind: 'expense', name: '水电费', color: '#5f9ea0', kids: ['水费', '电费'] },
    { kind: 'expense', name: '话费', color: '#8ab77a', kids: ['话费'] },
    { kind: 'income', name: '工资', color: '#6fbf6f', kids: [] },
    { kind: 'income', name: '副业', color: '#5f9ea0', kids: [] },
  ];
  const insCat = demoDb.prepare('INSERT INTO categories (name, kind, grp, color, parent_id, sort_order, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const catIdMap = {};
  let sort = 0;
  for (const c of catDefs) {
    const grp = c.kind === 'expense' ? '非必要' : '';
    const info = insCat.run(c.name, c.kind, grp, c.color, null, sort++, demoUser);
    catIdMap[c.name] = info.lastInsertRowid;
    for (const k of c.kids) insCat.run(k, c.kind, grp, '#98a6bd', info.lastInsertRowid, sort++, demoUser);
  }
  // 金库
  const insVault = demoDb.prepare('INSERT INTO vaults (name, balance_cents, sort_order, user_id) VALUES (?, ?, ?, ?)');
  const vaultIdMap = {};
  ['微信', '支付宝', '银行卡', '现金'].forEach((n, i) => { const v = insVault.run(n, 0, i, demoUser).lastInsertRowid; vaultIdMap[n] = v; });
  // 物件（演示）
  const insItem = demoDb.prepare('INSERT INTO items (name, amount_cents, purchase_date, sort_order, user_id) VALUES (?, ?, ?, ?, ?)');
  insItem.run('手机', 450000, '2026-01-10', 0, demoUser);
  insItem.run('电脑', 800000, '2025-08-01', 1, demoUser);
  insItem.run('耳机', 99900, '2026-06-15', 2, demoUser);

  // 交易：最近 12 个月的完整账本（符合常识，含必要/非必要、收入）
  const insTx = demoDb.prepare('INSERT INTO transactions (date, amount_cents, category_id, note, type, channel, grp, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const rnd = (a, b) => Math.round((a + Math.random() * (b - a)) * 100);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const now = new Date(), pad = (n) => String(n).padStart(2, '0');
  for (let m = 11; m >= 0; m--) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= dim; day++) {
      // 三餐（每天 1-2 笔合并）
      const meals = Math.random() < 0.6 ? [pick(['早餐', '午餐', '晚餐'])] : [pick(['早餐', '午餐']), pick(['午餐', '晚餐'])].filter((v, i, a) => a.indexOf(v) === i);
      for (const meal of meals) {
        const amt = meal === '早餐' ? rnd(4, 10) : meal === '午餐' ? rnd(12, 28) : rnd(18, 35);
        insTx.run(`${ym}-${pad(day)}`, amt, catIdMap['正餐'], meal, 'expense', pick(['微信', '现金']), '必要', demoUser);
      }
      // 通勤（多数天）
      if (Math.random() < 0.7) insTx.run(`${ym}-${pad(day)}`, rnd(3, 7), catIdMap['交通'], '地铁', 'expense', pick(['微信', '支付宝']), '必要', demoUser);
    }
    for (let day = 3; day <= dim; day += 5) insTx.run(`${ym}-${pad(day)}`, rnd(10, 24), catIdMap['零食饮料'], pick(['奶茶', '零食']), 'expense', pick(['微信', '支付宝']), '非必要', demoUser);
    for (let day = 5; day <= dim; day += 9) insTx.run(`${ym}-${pad(day)}`, rnd(15, 40), catIdMap['交通'], '打车', 'expense', pick(['微信', '支付宝']), '非必要', demoUser);
    insTx.run(`${ym}-05`, rnd(120, 260), catIdMap['水电费'], pick(['水费', '电费']), 'expense', '微信', '必要', demoUser);
    if (m % 2 === 0) insTx.run(`${ym}-08`, rnd(39, 58), catIdMap['话费'], '话费', 'expense', '支付宝', '必要', demoUser);
    insTx.run(`${ym}-10`, rnd(15, 30), catIdMap['订阅'], pick(['会员', '软件']), 'expense', '微信', '非必要', demoUser);
    if (Math.random() < 0.7) insTx.run(`${ym}-${pad(1 + Math.floor(Math.random() * 26))}`, rnd(50, 200), catIdMap['购物'], pick(['日用品', '服饰']), 'expense', '支付宝', '非必要', demoUser);
    if (Math.random() < 0.5) insTx.run(`${ym}-${pad(1 + Math.floor(Math.random() * 26))}`, rnd(30, 120), catIdMap['娱乐'], pick(['电影', '游戏']), 'expense', '微信', '非必要', demoUser);
    if (Math.random() < 0.3) insTx.run(`${ym}-${pad(1 + Math.floor(Math.random() * 26))}`, rnd(200, 800), catIdMap['数码'], pick(['手机', '耳机']), 'expense', '支付宝', '非必要', demoUser);
    // 收入
    insTx.run(`${ym}-15`, 800000, catIdMap['工资'], '工资', 'income', '银行卡', '必要', demoUser);
    if (Math.random() < 0.3) insTx.run(`${ym}-${pad(20 + Math.floor(Math.random() * 8))}`, rnd(300, 1500), catIdMap['副业'], '副业', 'income', '支付宝', '', demoUser);
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'expense',   -- expense | income
      grp TEXT DEFAULT '必要',                 -- 必要 / 非必要（仅 expense 用）
      color TEXT DEFAULT '#7aa2c4',
      parent_id INTEGER DEFAULT NULL,         -- 大类下的小类（子类别）
      sort_order INTEGER DEFAULT 0,
      user_id INTEGER NOT NULL DEFAULT 0      -- v3 多用户归属
    );
    -- 大类名：支出/收入各自唯一（按用户）；跨「支出/收入」可重名。小类允许重名
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_top_name ON categories(user_id, kind, name) WHERE parent_id IS NULL;
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,                      -- YYYY-MM-DD（允许未来日期 → 自动归远期）
      amount_cents INTEGER NOT NULL,           -- 金额（分）
      category_id INTEGER NOT NULL REFERENCES categories(id),
      note TEXT DEFAULT '',                    -- 小类
      remark TEXT DEFAULT '',                  -- v0.2 独立备注（不参与分类）
      share_kind TEXT DEFAULT '',              -- e.g. "÷2"
      type TEXT NOT NULL DEFAULT 'expense',    -- expense | income
      channel TEXT DEFAULT '',                 -- 微信 / 支付宝 / 银行卡 / 现金 ...
      grp TEXT DEFAULT '非必要',               -- 必要 / 非必要（按每笔设置）
      created_at TEXT DEFAULT (datetime('now')),
      user_id INTEGER NOT NULL DEFAULT 0       -- v3 多用户归属
    );
    CREATE TABLE IF NOT EXISTS vaults (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      user_id INTEGER NOT NULL DEFAULT 0       -- v3 多用户归属
    );
    CREATE TABLE IF NOT EXISTS vault_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id INTEGER NOT NULL,
      delta_cents INTEGER NOT NULL,
      after_cents INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      user_id INTEGER NOT NULL DEFAULT 0       -- v3 多用户归属
    );
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      purchase_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      sort_order INTEGER DEFAULT 0,
      user_id INTEGER NOT NULL DEFAULT 0       -- v3 多用户归属
    );
    -- v0.2 第五轮：物件的「产生效益」（收益，负向影响总价值）/「额外投入」（支出，正向影响总价值）
    CREATE TABLE IF NOT EXISTS item_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      delta_cents INTEGER NOT NULL,
      kind TEXT NOT NULL,                -- gain(产生效益) | invest(额外投入)
      note TEXT DEFAULT '',
      event_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      user_id INTEGER NOT NULL DEFAULT 0       -- v3 多用户归属
    );
    CREATE INDEX IF NOT EXISTS idx_ie_item ON item_events(item_id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    -- v3 多用户：用户 + 登录会话
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      ai_quota INTEGER NOT NULL DEFAULT 0,      -- AI 剩余调用次数
      is_admin INTEGER NOT NULL DEFAULT 0,
      demo_mode INTEGER NOT NULL DEFAULT 1,     -- v4 模拟模式（新用户默认模拟）
      last_insight TEXT DEFAULT '',             -- v4 最近一次 AI 消费洞察文本（保存，刷新/重登仍在）
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_txn_cat ON transactions(category_id);
    CREATE INDEX IF NOT EXISTS idx_ve_vault ON vault_events(vault_id);
  `);
}

function migrate() {
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  const hadGrp = cols.includes('grp');
  if (!cols.includes('type')) db.exec("ALTER TABLE transactions ADD COLUMN type TEXT NOT NULL DEFAULT 'expense'");
  if (!cols.includes('channel')) db.exec("ALTER TABLE transactions ADD COLUMN channel TEXT DEFAULT ''");
  if (!cols.includes('grp')) db.exec("ALTER TABLE transactions ADD COLUMN grp TEXT DEFAULT '非必要'");
  if (!hadGrp) db.exec("UPDATE transactions SET grp = (SELECT COALESCE(c.grp,'非必要') FROM categories c WHERE c.id = transactions.category_id)");
  if (!cols.includes('remark')) db.exec("ALTER TABLE transactions ADD COLUMN remark TEXT DEFAULT ''");

  const ccols = db.prepare('PRAGMA table_info(categories)').all().map((c) => c.name);
  const hadCatSort = ccols.includes('sort_order');
  if (!ccols.includes('parent_id')) db.exec('ALTER TABLE categories ADD COLUMN parent_id INTEGER DEFAULT NULL');
  if (!hadCatSort) db.exec('ALTER TABLE categories ADD COLUMN sort_order INTEGER DEFAULT 0');
  // 仅在首次新增 sort_order 列时初始化一次，避免每次启动覆盖用户拖拽的顺序
  if (!hadCatSort) db.exec("UPDATE categories SET sort_order = id WHERE sort_order = 0 OR sort_order IS NULL");
  const vcols = db.prepare('PRAGMA table_info(vaults)').all().map((c) => c.name);
  const hadVaultSort = vcols.includes('sort_order');
  if (!hadVaultSort) db.exec("ALTER TABLE vaults ADD COLUMN sort_order INTEGER DEFAULT 0");
  if (!hadVaultSort) db.exec("UPDATE vaults SET sort_order = id WHERE sort_order = 0 OR sort_order IS NULL");
  // v0.2 bug修复：物件 sort_order（拖拽排序）
  const icols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  const hadItemSort = icols.includes('sort_order');
  if (!hadItemSort) db.exec('ALTER TABLE items ADD COLUMN sort_order INTEGER DEFAULT 0');
  if (!hadItemSort) db.exec("UPDATE items SET sort_order = id WHERE sort_order = 0 OR sort_order IS NULL");
  // v3 多用户：给业务表加 user_id 列（旧库 ALTER ADD，默认 0）
  for (const tbl of ['categories', 'transactions', 'vaults', 'vault_events', 'items', 'item_events']) {
    const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map((c) => c.name);
    if (!cols.includes('user_id')) db.exec(`ALTER TABLE ${tbl} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0`);
  }
  // v4 模拟模式：users 表加 demo_mode 列（新用户默认模拟）
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!ucols.includes('demo_mode')) db.exec('ALTER TABLE users ADD COLUMN demo_mode INTEGER NOT NULL DEFAULT 1');
  // v4 洞察保留：users 表加 last_insight 列
  if (!ucols.includes('last_insight')) db.exec('ALTER TABLE users ADD COLUMN last_insight TEXT DEFAULT \'\'');

  // 大类名唯一：支出/收入各自唯一、跨支出/收入可重名（幂等，只在缺失时建）
  // v3 多用户：大类名唯一改为按 (user_id, kind, name)。先删旧的全局唯一索引（若存在），再建新的。
  db.exec("DROP INDEX IF EXISTS idx_cat_top_name");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_top_name ON categories(user_id, kind, name) WHERE parent_id IS NULL");
}

function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (n === 0) {
    const defaults = [
      ['三餐', 'expense', '必要', '#d97a6c'],
      ['水电费', 'expense', '必要', '#5f9ea0'],
      ['话费', 'expense', '必要', '#8ab77a'],
      ['交通', 'expense', '非必要', '#7aa2c4'],
      ['购物', 'expense', '非必要', '#c98fd6'],
      ['数码', 'expense', '非必要', '#7a7fd6'],
      ['学习', 'expense', '非必要', '#d6b16e'],
      ['娱乐', 'expense', '非必要', '#c4b77a'],
      ['零食饮料', 'expense', '非必要', '#e0a45e'],
      ['氪金', 'expense', '非必要', '#d68a8a'],
      ['社交请客', 'expense', '非必要', '#9a8ad6'],
      ['订阅', 'expense', '非必要', '#6ec4c4'],
      ['收入', 'income', '', '#6fbf6f'],
    ];
    const ins = db.prepare('INSERT INTO categories (name, kind, grp, color) VALUES (?, ?, ?, ?)');
    for (const d of defaults) ins.run(...d);
    // 大类下的小类（子类别）——作为 备注 可选 / 自动归类的依据
    const childDefaults = [
      ['三餐', ['早餐', '午餐', '晚餐']],
      ['交通', ['地铁', '公交', '打车', '高铁']],
      ['购物', ['日用品', '服饰', '快递运费']],
      ['数码', ['手机', '耳机', '电脑配件']],
      ['学习', ['网课', '考试', '教材']],
      ['娱乐', ['电影', '门票景点', '旅行']],
      ['零食饮料', ['奶茶咖啡', '零食', '水果']],
      ['订阅', ['会员', '软件']],
    ];
    const getId = db.prepare('SELECT id FROM categories WHERE name=?');
    const insChild = db.prepare("INSERT INTO categories (name, kind, grp, color, parent_id) VALUES (?, 'expense', '非必要', '#98a6bd', ?)");
    for (const [parent, children] of childDefaults) {
      const p = getId.get(parent);
      if (p) for (const c of children) insChild.run(c, p.id);
    }
    // 首次建库：给没有小类的大类补一个「默认」小类（只在空库时执行一次）
    ensureDefaultChildren();
  }
  const { n: vn } = db.prepare('SELECT COUNT(*) AS n FROM vaults').get();
  if (vn === 0) {
    const ins = db.prepare('INSERT INTO vaults (name, balance_cents) VALUES (?, 0)');
    for (const name of ['微信', '支付宝', '银行卡', '现金']) ins.run(name);
  }
}

// v3 阶段二：新用户注册时，为「该用户」建一套默认分类 + 金库（每个用户独立）
function seedUserCategories(userId) {
  // 只在该用户没有任何分类时才建（幂等）
  if (db.prepare('SELECT COUNT(*) AS n FROM categories WHERE user_id=?').get(userId).n > 0) return;
  const defaults = [
    ['三餐', 'expense', '必要', '#d97a6c'], ['水电费', 'expense', '必要', '#5f9ea0'],
    ['话费', 'expense', '必要', '#8ab77a'], ['交通', 'expense', '非必要', '#7aa2c4'],
    ['购物', 'expense', '非必要', '#c98fd6'], ['数码', 'expense', '非必要', '#7a7fd6'],
    ['学习', 'expense', '非必要', '#d6b16e'], ['娱乐', 'expense', '非必要', '#c4b77a'],
    ['零食饮料', 'expense', '非必要', '#e0a45e'], ['氪金', 'expense', '非必要', '#d68a8a'],
    ['社交请客', 'expense', '非必要', '#9a8ad6'], ['订阅', 'expense', '非必要', '#6ec4c4'],
    ['收入', 'income', '', '#6fbf6f'],
  ];
  const ins = db.prepare('INSERT INTO categories (name, kind, grp, color, user_id) VALUES (?, ?, ?, ?, ?)');
  for (const d of defaults) ins.run(d[0], d[1], d[2], d[3], userId);
  const childDefaults = [
    ['三餐', ['早餐', '午餐', '晚餐']], ['交通', ['地铁', '公交', '打车', '高铁']],
    ['购物', ['日用品', '服饰', '快递运费']], ['数码', ['手机', '耳机', '电脑配件']],
    ['学习', ['网课', '考试', '教材']], ['娱乐', ['电影', '门票景点', '旅行']],
    ['零食饮料', ['奶茶咖啡', '零食', '水果']], ['订阅', ['会员', '软件']],
  ];
  const getId = db.prepare('SELECT id FROM categories WHERE name=? AND user_id=?');
  const insChild = db.prepare("INSERT INTO categories (name, kind, grp, color, parent_id, user_id) VALUES (?, 'expense', '非必要', '#98a6bd', ?, ?)");
  for (const [parent, children] of childDefaults) {
    const p = getId.get(parent, userId);
    if (p) for (const c of children) insChild.run(c, p.id, userId);
  }
  // 给没有小类的大类补「默认」
  const tops = db.prepare('SELECT id, kind FROM categories WHERE parent_id IS NULL AND user_id=?').all(userId);
  const hasChild = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE parent_id=? AND user_id=?');
  const insDef = db.prepare("INSERT INTO categories (name, kind, grp, color, parent_id, user_id) VALUES ('默认', ?, '', '#98a6bd', ?, ?)");
  for (const t of tops) if (!hasChild.get(t.id, userId).n) insDef.run(t.kind, t.id, userId);
  // 默认金库（每个用户自己的）
  const insVault = db.prepare('INSERT INTO vaults (name, balance_cents, user_id) VALUES (?, 0, ?)');
  for (const name of ['微信', '支付宝', '银行卡', '现金']) insVault.run(name, userId);
}

// v3 阶段二：把无主的历史数据（user_id=0）归给 admin（第一个 admin 用户）
function assignLegacyData() {
  const admin = db.prepare('SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1').get();
  if (!admin) return;
  const tables = ['categories', 'transactions', 'vaults', 'vault_events', 'items', 'item_events'];
  for (const t of tables) {
    db.prepare(`UPDATE ${t} SET user_id=? WHERE user_id=0 OR user_id IS NULL`).run(admin.id);
  }
  // v4：管理员（主人）默认真实模式，新用户才是模拟
  db.prepare('UPDATE users SET demo_mode=0 WHERE id=?').run(admin.id);
}

// 为所有“暂无小类”的大类补一个「默认」小类
function ensureDefaultChildren() {
  const tops = db.prepare("SELECT id, kind FROM categories WHERE parent_id IS NULL").all();
  const hasChild = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE parent_id=?');
  const ins = db.prepare("INSERT INTO categories (name, kind, grp, color, parent_id) VALUES (?, ?, '', '#98a6bd', ?)");
  for (const t of tops) {
    if (!hasChild.get(t.id).n) ins.run('默认', t.kind, t.id);
  }
}

// --- 工具 ---
function yuanToCents(yuan) { return Math.round(Number(yuan) * 100); }
function centsToYuan(cents) { return Math.round(Number(cents)) / 100; }
function getSetting(k) { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; }
function setSetting(k, v) { db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v); }
function hashPwd(p) { return crypto.createHash('sha256').update(String(p)).digest('hex'); }
function randomToken() { return crypto.randomBytes(24).toString('hex'); }
function createSession(userId) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s) return null;
  return db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
const MAX_BODY = 1024 * 1024; // 1MB
function readBody(req) {
  return new Promise((resolve) => {
    let body = '', size = 0, tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; req.destroy(); resolve({}); return; }
      body += c;
    });
    req.on('end', () => { if (tooBig) return; try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'text/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
    : 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
function monthOf(dateStr) { return String(dateStr).slice(0, 7); }

// --- 金库 ---
function getVaultByName(name, userId) { return db.prepare('SELECT * FROM vaults WHERE name=? AND user_id=?').get(name, userId); }
function ensureVault(name, userId) {
  let v = getVaultByName(name, userId);
  if (!v) { db.prepare('INSERT INTO vaults (name, balance_cents, user_id) VALUES (?, 0, ?)').run(name, userId); v = getVaultByName(name, userId); }
  return v;
}
function vaultDelta(name, deltaCents, note, txId, userId) {
  if (!name) return;
  const v = ensureVault(name, userId);
  const after = v.balance_cents + deltaCents;
  // 在 note 末尾追加 #txId，前端解析后点击行可跳到对应账单编辑
  const fullNote = txId ? `${note || ''} #${txId}`.trim() : (note || '');
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE vaults SET balance_cents=?, updated_at=datetime('now') WHERE id=?").run(after, v.id);
    db.prepare('INSERT INTO vault_events (vault_id, delta_cents, after_cents, note, user_id) VALUES (?,?,?,?,?)').run(v.id, deltaCents, after, fullNote, userId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
function txnDelta(t) {
  if (!t.channel || t.channel === '总资产') return 0;
  return (t.type === 'income' ? 1 : -1) * t.amount_cents;
}
function applyTxnToVault(t, userId) {
  if (!t.channel || t.channel === '总资产') return;
  const d = txnDelta(t);
  vaultDelta(t.channel, d, `${t.type === 'income' ? '收入' : '支出'} ${t.note || t.date}`, t.id, userId);
}
// 把备注若为大类的小类（子类别），自动建档，方便下次在备注里选择
function ensureChild(parentId, name, userId) {
  if (!parentId || !name) return null;
  const existing = db.prepare('SELECT id FROM categories WHERE parent_id=? AND name=? AND user_id=?').get(parentId, name, userId);
  if (existing) return existing.id;
  const info = db.prepare("INSERT INTO categories (name, kind, grp, color, parent_id, user_id) VALUES (?, 'expense', '非必要', '#98a6bd', ?, ?)").run(name, parentId, userId);
  return info.lastInsertRowid;
}
function reverseTxnFromVault(t, userId) {
  if (!t.channel || t.channel === '总资产') return;
  const d = txnDelta(t);
  vaultDelta(t.channel, -d, '编辑/删除回滚', null, userId);
}
// 若某大类下没有「默认」小类，就补一个（保证每个大类至少有一个默认）
function ensureDefaultChild(parentId, userId) {
  const exists = db.prepare('SELECT id FROM categories WHERE parent_id=? AND name=? AND user_id=?').get(parentId, '默认', userId);
  if (exists) return exists.id;
  const p = db.prepare('SELECT kind FROM categories WHERE id=? AND user_id=?').get(parentId, userId);
  const info = db.prepare("INSERT INTO categories (name, kind, grp, color, parent_id, sort_order, user_id) VALUES ('默认', ?, '', '#98a6bd', ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM categories), ?)").run(p.kind, parentId, userId);
  return info.lastInsertRowid;
}

// --- 趋势（按天/周/月/季/年单位） ---
function computeTrend(unit, n, ttype = 'expense', userId) {
  const db = activeDb; // 支持演示库
  n = Math.max(1, Math.min(Number(n) || 12, 120));
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const mondayOf = (d) => { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; };

  let start, buckets;
  const build = (i) => {
    let sDate, key, label;
    if (unit === 'day') {
      sDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i));
      key = ymd(sDate); label = key.slice(5);
    } else if (unit === 'week') {
      const base = mondayOf(now);
      sDate = new Date(base); sDate.setDate(base.getDate() - (n - 1 - i) * 7);
      key = ymd(sDate); label = sDate.getMonth() + 1 + '/' + sDate.getDate();
    } else if (unit === 'month') {
      sDate = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1);
      key = `${sDate.getFullYear()}-${pad(sDate.getMonth() + 1)}`; label = `${String(sDate.getFullYear()).slice(2)}-${pad(sDate.getMonth() + 1)}`;
    } else if (unit === 'quarter') {
      const monthIndex = now.getMonth() - (n - 1 - i) * 3;
      sDate = new Date(now.getFullYear(), monthIndex, 1);
      const y = sDate.getFullYear(); const q = Math.floor(sDate.getMonth() / 3) + 1;
      key = `${y}-Q${q}`; label = `${String(y).slice(2)}Q${q}`;
    } else { // year
      sDate = new Date(now.getFullYear() - (n - 1 - i), 0, 1);
      key = String(sDate.getFullYear()); label = key;
    }
    return { sDate, end: unit === 'day' ? new Date(sDate.getTime() + 86400000) : unit === 'week' ? new Date(sDate.getTime() + 7 * 86400000) : unit === 'month' ? new Date(sDate.getFullYear(), sDate.getMonth() + 1, 1) : unit === 'quarter' ? new Date(sDate.getFullYear(), sDate.getMonth() + 3, 1) : new Date(sDate.getFullYear() + 1, 0, 1), key, label };
  };

  buckets = Array.from({ length: n }, (_, i) => build(i));
  const rangeStart = ymd(buckets[0].sDate);
  const rows = db.prepare('SELECT date, amount_cents FROM transactions WHERE user_id=? AND type=? AND date >= ? AND date < ?')
    .all(userId, ttype, rangeStart, ymd(buckets[n - 1].end) || `${now.getFullYear() + 1}-01-01`);
  const sums = new Map(buckets.map((b) => [b.key, 0]));
  for (const r of rows) {
    const d = new Date(r.date + 'T00:00:00');
    let key;
    if (unit === 'day') key = r.date;
    else if (unit === 'week') key = ymd(mondayOf(d));
    else if (unit === 'month') key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    else if (unit === 'quarter') key = `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
    else key = String(d.getFullYear());
    if (sums.has(key)) sums.set(key, sums.get(key) + r.amount_cents);
  }
  const labels = buckets.map((b) => b.label);
  const values = buckets.map((b) => sums.get(b.key));

  const moms = values.map((v, i) => (i === 0 ? null : (values[i - 1] ? ((v - values[i - 1]) / values[i - 1]) * 100 : null)));
  let yoys = values.map(() => null);
  if (unit === 'month' || unit === 'quarter') {
    const ymQ = db.prepare(unit === 'month'
      ? "SELECT COALESCE(SUM(amount_cents),0) AS cents FROM transactions WHERE user_id=? AND type=? AND strftime('%Y-%m', date)=?"
      : "SELECT COALESCE(SUM(amount_cents),0) AS cents FROM transactions WHERE user_id=? AND type=? AND date>=? AND date<?");
    yoys = buckets.map((b, i) => {
      let r;
      if (unit === 'month') {
        const parts = b.key.split('-');
        r = ymQ.get(userId, ttype, `${Number(parts[0]) - 1}-${parts[1]}`);
      } else {
        const [y, q] = b.key.split('-Q').map(Number);
        const sm = (q - 1) * 3 + 1;
        r = ymQ.get(userId, ttype, `${y - 1}-${String(sm).padStart(2, '0')}-01`, `${y - 1}-${String(sm + 3).padStart(2, '0')}-01`);
      }
      return r.cents > 0 ? ((values[i] - r.cents) / r.cents) * 100 : null;
    });
  }
  const mom = moms[moms.length - 1] ?? null;
  const yoy = yoys[yoys.length - 1] ?? null;
  return { labels, values, unit, mom, yoy, moms, yoys };
}

function computeSummary(month, userId) {
  const db = activeDb; // 支持演示库：dispatch 在模拟模式切到 demoDb
  const expense = db.prepare(`
    SELECT COALESCE(SUM(amount_cents),0) AS t, COUNT(*) AS n FROM transactions
    WHERE user_id=? AND strftime('%Y-%m', date)=? AND type='expense'
  `).get(userId, month);
  const income = db.prepare(`
    SELECT COALESCE(SUM(amount_cents),0) AS t FROM transactions
    WHERE user_id=? AND strftime('%Y-%m', date)=? AND type='income'
  `).get(userId, month);

  const catBreakdown = db.prepare(`
    SELECT COALESCE(p.id, c.id) AS cid, COALESCE(p.name, c.name) AS name,
           COALESCE(p.color, c.color) AS color, COALESCE(p.grp, c.grp) AS grp,
           COALESCE(SUM(t.amount_cents),0) AS cents
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id
    WHERE t.user_id=? AND strftime('%Y-%m', t.date) = ? AND t.type='expense' AND COALESCE(p.kind, c.kind) = 'expense'
    GROUP BY COALESCE(p.id, c.id) ORDER BY cents DESC
  `).all(userId, month);

  const byGroup = db.prepare(`
    SELECT t.grp AS grp, COALESCE(SUM(t.amount_cents),0) AS cents
    FROM transactions t
    WHERE t.user_id=? AND strftime('%Y-%m', t.date) = ? AND t.type='expense' AND t.grp IN ('必要','非必要')
    GROUP BY t.grp
  `).all(userId, month);

  const incomeCats = db.prepare(`
    SELECT COALESCE(p.id, c.id) AS cid, COALESCE(p.name, c.name) AS name, COALESCE(p.color, c.color) AS color,
           COALESCE(SUM(t.amount_cents),0) AS cents
    FROM transactions t JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id
    WHERE t.user_id=? AND strftime('%Y-%m', t.date) = ? AND t.type='income' AND COALESCE(p.kind, c.kind) = 'income'
    GROUP BY COALESCE(p.id, c.id) ORDER BY cents DESC
  `).all(userId, month);

  const latestRow = db.prepare("SELECT MAX(strftime('%Y-%m', date)) AS m FROM transactions WHERE user_id=?").get(userId);
  const earliestRow = db.prepare("SELECT MIN(strftime('%Y-%m', date)) AS m FROM transactions WHERE user_id=?").get(userId);

  return {
    month,
    latestMonth: latestRow.m || month,
    earliestMonth: earliestRow.m || month,
    total: centsToYuan(expense.t),
    income: centsToYuan(income.t),
    net: centsToYuan(income.t - expense.t),
    count: expense.n,
    categories: catBreakdown.map((r) => ({ id: r.cid, name: r.name, color: r.color, grp: r.grp, cents: r.cents, yuan: centsToYuan(r.cents) })),
    incomeCategories: incomeCats.map((r) => ({ id: r.cid, name: r.name, color: r.color, cents: r.cents, yuan: centsToYuan(r.cents) })),
    groups: byGroup.map((r) => ({ grp: r.grp, cents: r.cents, yuan: centsToYuan(r.cents) })),
  };
}

// --- 路由（分发表） ---
const routes = [];
function addRoute(method, pattern, handler) {
  const keys = [];
  const src = pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; });
  routes.push({ method, re: new RegExp('^' + src + '$'), keys, handler });
}
async function dispatch(req, res, url) {
  const p = url.pathname;
  // v3 鉴权：所有 /api/*（除 /api/auth/*）都要求已登录
  const needsAuth = p.startsWith('/api/') && !p.startsWith('/api/auth/');
  if (needsAuth) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = userFromToken(token);
    if (!user) return json(res, 401, { error: '未登录或登录已过期' });
    req.user = user;
    // v3 阶段二：生效的 userId。普通用户=自己；admin 默认看自己，可带 ?asUserId= 切换到其他用户
    let uid = user.id;
    if (user.is_admin) {
      const asId = Number(url.searchParams.get('asUserId'));
      if (asId) uid = asId;
    }
    req.userId = uid;
  }
  // v5 独立演示库：模拟模式下，GET 数据请求查只读 demoDb；写请求一律拒绝
  if (needsAuth && req.user) {
    if (req.user.demo_mode) {
      // 演示模式：只读；查询目标切到 demoDb（所有演示数据 user_id=-1）
      if (req.method === 'GET') {
        openDemoDb();
        activeDb = demoDb;
        req.userId = -1; // 演示数据统一 user_id = -1
      } else if (!p.startsWith('/api/ai/') && !p.startsWith('/api/demo-mode') && !p.startsWith('/api/auth/')) {
        return json(res, 403, { error: '模拟模式下无法修改数据，请退出模拟模式' });
      }
    } else {
      activeDb = db;
    }
  }
  for (const r of routes) {
    if (req.method !== r.method) continue;
    const m = p.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = m[i + 1]));
    try { return await r.handler(req, res, url, params); }
    catch (e) { return json(res, 500, { error: String(e && e.message || e) }); }
  }
  return json(res, 404, { error: 'not found' });
}
const staticH = (file) => async (req, res) => serveFile(res, path.join(WEB_DIR, file));

addRoute('GET', '/', staticH('index.html'));
addRoute('GET', '/index.html', staticH('index.html'));
addRoute('GET', '/app.js', staticH('app.js'));
addRoute('GET', '/styles.css', staticH('styles.css'));

// --- 用户认证（v3 多用户）---
// 禁用用户名：包含以下任一关键词（大小写不敏感）即拒绝。要加规则只需在数组追加。
// 第一组：管理员实名 / 系统保留名；第二组：违禁词（低俗/不雅/敏感）。可按需增补。
function isReservedUsername(name) {
  const n = name.toLowerCase();
  const reserved = ['林子恒', 'admin', 'administrator', 'root', 'zhlerror363', 'system'];
  const vulgar = ['傻逼', '傻b', '蠢货', '白痴', '妈的', '操你', '妈的逼', 'cnm', 'nmsl', 'fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', '草泥马', '妈卖批', '去你妈', '王八蛋', '狗娘养的', '色情', '裸聊', '约炮', '赌博', '诈骗', '代孕'];
  return reserved.some((w) => n.includes(w)) || vulgar.some((w) => n.includes(w));
}
addRoute('POST', '/api/auth/register', async (req, res) => {
  const body = await readBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || username.length < 2) return json(res, 400, { error: '用户名至少 2 个字符' });
  if (!password || password.length < 4) return json(res, 400, { error: '密码至少 4 位' });
  // 保留/禁用用户名：只要包含这些词（大小写不敏感）就拒绝 —— 无需穷举变体
  if (isReservedUsername(username)) return json(res, 409, { error: '该用户名已被注册' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) return json(res, 409, { error: '用户名已被占用' });
  const info = db.prepare('INSERT INTO users (username, password_hash, ai_quota) VALUES (?, ?, ?)').run(username, hashPwd(password), 10);
  const token = createSession(info.lastInsertRowid);
  // 新用户：初始化一套默认分类 + 默认进模拟模式（demo_mode 默认 1）+ 送 10 次 AI 额度
  seedUserCategories(info.lastInsertRowid);
  return json(res, 200, { ok: true, token, username, demoMode: true, aiQuota: 10 });
});
addRoute('POST', '/api/auth/login', async (req, res) => {
  const body = await readBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || user.password_hash !== hashPwd(password)) return json(res, 401, { error: '用户名或密码错误' });
  const token = createSession(user.id);
  return json(res, 200, { ok: true, token, username: user.username, isAdmin: !!user.is_admin, aiQuota: user.ai_quota, demoMode: !!user.demo_mode, lastInsight: user.last_insight || '' });
});
addRoute('POST', '/api/auth/logout', async (req, res, url) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  return json(res, 200, { ok: true });
});
addRoute('GET', '/api/auth/me', async (req, res, url) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = userFromToken(token);
  if (!user) return json(res, 401, { error: '未登录' });
  return json(res, 200, { username: user.username, isAdmin: !!user.is_admin, aiQuota: user.ai_quota, id: user.id, demoMode: !!user.demo_mode, lastInsight: user.last_insight || '' });
});
// v4 模拟模式：切换 demo_mode（进入/退出模拟模式）——注意不在 /api/auth 下，否则 dispatch 不鉴权
addRoute('PUT', '/api/demo-mode', async (req, res, url) => {
  const body = await readBody(req);
  const on = body.demoMode ? 1 : 0;
  db.prepare('UPDATE users SET demo_mode=? WHERE id=?').run(on, req.user.id);
  return json(res, 200, { ok: true, demoMode: !!on });
});
addRoute('GET', '/api/admin/users', async (req, res) => {
  if (!req.user.is_admin) return json(res, 403, { error: '需要管理员权限' });
  const users = db.prepare('SELECT id, username, ai_quota, is_admin, created_at FROM users ORDER BY id').all();
  return json(res, 200, users);
});
// v3 阶段三：admin 给某用户设置/增减 AI 额度
addRoute('PUT', '/api/admin/users/:id/quota', async (req, res, url, params) => {
  if (!req.user.is_admin) return json(res, 403, { error: '需要管理员权限' });
  const body = await readBody(req);
  const userId = params.id;
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!target) return json(res, 404, { error: '用户不存在' });
  // quota 有两种语义：给多少（set）或增减多少（add）
  let newQuota;
  if (body.add != null) newQuota = Math.max(0, target.ai_quota + Number(body.add));
  else if (body.set != null) newQuota = Math.max(0, Number(body.set));
  else return json(res, 400, { error: '缺少 set 或 add' });
  db.prepare('UPDATE users SET ai_quota=? WHERE id=?').run(newQuota, userId);
  return json(res, 200, { ok: true, aiQuota: newQuota });
});
async function callDeepSeek(messages) {
  if (!DEEPSEEK_API_KEY) throw new Error('未配置 DEEPSEEK_API_KEY');
  const res = await fetch(DEEPSEEK_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.2, max_tokens: 1500 }),
  });
  if (!res.ok) throw new Error('DeepSeek 调用失败: ' + res.status);
  const data = await res.json();
  return data.choices && data.choices[0] && data.choices[0].message.content;
}
// 检查用户 AI 额度是否够（只查不扣）
function checkQuota(userId) {
  const u = db.prepare('SELECT ai_quota FROM users WHERE id=?').get(userId);
  if (!u) return { ok: false, quota: 0 };
  return u.ai_quota > 0 ? { ok: true, quota: u.ai_quota } : { ok: false, quota: 0 };
}
// 扣减用户 AI 额度，返回剩余
function consumeQuota(userId) {
  const u = db.prepare('SELECT ai_quota FROM users WHERE id=?').get(userId);
  if (!u) return null;
  if (u.ai_quota <= 0) return { ok: false, quota: 0 };
  const left = u.ai_quota - 1;
  db.prepare('UPDATE users SET ai_quota=? WHERE id=?').run(left, userId);
  return { ok: true, quota: left };
}
// v4 模拟模式：预设的演示 AI 记账解析（从文本里随便挑几个数字，给用户看效果，不真调 API）
function demoParseItems(text) {
  const today = new Date().toISOString().slice(0, 10);
  const nums = (text.match(/\d+(?:\.\d+)?/g) || []);
  const base = [
    { category: '交通', channel: '微信', grp: '非必要' },
    { category: '正餐', channel: '微信', grp: '必要' },
    { category: '购物', channel: '支付宝', grp: '非必要' },
  ];
  return nums.slice(0, 3).map((n, i) => ({
    date: today, amount: parseFloat(n), type: 'expense',
    category: base[i].category, note: '演示', channel: base[i].channel, grp: base[i].grp,
  }));
}
// v4 模拟模式：预设的演示消费洞察
const demoInsight = '这是模拟数据为你演示的消费洞察效果：\n\n你像一位懂得平衡生活的人——日常三餐和交通打理得井井有条，偶尔为购物和体验付费，整体节奏从容。\n建议留意每月小额高频的支出，攒一攒也能省下一笔可观的"小确幸基金"。';

// 智能记账：把用户粘贴的乱文本 → AI 解析成结构化记账条目
addRoute('POST', '/api/ai/parse', async (req, res, url) => {
  const body = await readBody(req);
  const text = String(body.text || '').trim();
  if (!text) return json(res, 400, { error: '请粘贴内容' });
  if (text.length > 2000) return json(res, 400, { error: '内容过长（最多 2000 字）' });
  // v4 模拟模式：不调 API、不扣额度，返回预设演示解析结果
  if (req.user.demo_mode) {
    return json(res, 200, { items: demoParseItems(text), quotaLeft: req.user.ai_quota, demoMode: true });
  }
  const quota = checkQuota(req.userId);
  if (!quota.ok) return json(res, 429, { error: 'AI 额度已用完，联系管理员充值' });
  try {
    // 取该用户的大类列表，让 AI 只能从已有类别里选（贴合用户自己的分类体系）
    const myCats = db.prepare('SELECT DISTINCT name FROM categories WHERE user_id=? AND parent_id IS NULL').all(req.userId).map((c) => c.name);
    const catList = myCats.length ? myCats.join('、') : '（暂无，用户会生成）';
    const today = new Date().toISOString().slice(0, 10);
    const sys = '你是记账助手。从用户输入中提取记账条目，返回严格 JSON 数组（不要 markdown），每项含：' +
      'date(YYYY-MM-DD，若输入是"周三/昨天/前天"等相对日期，解析成最近的对应日期，否则用今天)，' +
      'amount(数字)，type("expense"或"income")，category(必须从这些大类里选一个最接近的：' + catList + '，不能自创)，' +
      'note(小类/描述，简短)，channel(微信/支付宝/银行卡/现金，猜不出用"")，grp(支出填"必要"或"非必要"，收入填"")。' +
      '金额可能带文字（如"30块"）。只返回 JSON 数组，不要任何解释文字。今天是 ' + today + '。';
    const content = await callDeepSeek([{ role: 'system', content: sys }, { role: 'user', content: text }]);
    // 提取 JSON 数组（LLM 可能包在 ```json ... ``` 里）
    const m = content.match(/\[[\s\S]*\]/);
    if (!m) return json(res, 500, { error: 'AI 无法解析，请调整输入' });
    let items;
    try { items = JSON.parse(m[0]); } catch (e) { return json(res, 500, { error: 'AI 返回格式错误' }); }
    // AI 成功返回后才扣额度（避免调用失败让用户白扣）
    consumeQuota(req.userId);
    return json(res, 200, { items, quotaLeft: quota.quota - 1 });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

// AI 消费洞察：取该用户近 3 个月交易统计，交给 DeepSeek 生成消费画像文字
addRoute('POST', '/api/ai/insight', async (req, res, url) => {
  // v4 模拟模式：不调 API、不扣额度，返回预设演示洞察
  if (req.user.demo_mode) {
    db.prepare('UPDATE users SET last_insight=? WHERE id=?').run(demoInsight, req.user.id);
    return json(res, 200, { insight: demoInsight, quotaLeft: req.user.ai_quota, demoMode: true });
  }
  const quota = checkQuota(req.userId);
  if (!quota.ok) return json(res, 429, { error: 'AI 额度已用完，联系管理员充值' });
  try {
    const uid = req.userId;
    // 取该用户「最近有数据的 3 个月」（按交易日期找最新的月份，往前推），而不是固定最近3个月。
    const pad = (n) => String(n).padStart(2, '0');
    const monthsWithData = db.prepare(`
      SELECT DISTINCT strftime('%Y-%m', date) AS m FROM transactions WHERE user_id=? AND type='expense' AND amount_cents>0
      ORDER BY m DESC LIMIT 3
    `).all(uid).map((r) => r.m);
    const months = monthsWithData.length ? monthsWithData : [new Date().toISOString().slice(0, 7)];
    const monthInfo = months.map((m) => {
      const s = computeSummary(m, uid);
      return { month: m, expense: s.total, income: s.income, count: s.count };
    });
    // 这些月份的分类 TOP（查询范围 = earliest of months 到 now，简化：用所有选取月份的交易）
    const startMonth = months[months.length - 1] + '-01';
    const topCats = db.prepare(`
      SELECT COALESCE(p.name, c.name) AS name, COALESCE(SUM(t.amount_cents),0) AS cents
      FROM transactions t JOIN categories c ON c.id=t.category_id LEFT JOIN categories p ON p.id=c.parent_id
      WHERE t.user_id=? AND t.date>=? AND t.date<? AND t.type='expense'
      GROUP BY COALESCE(p.id, c.id) ORDER BY cents DESC LIMIT 6
    `).all(uid, startMonth, months[0] + '-99');
    const grpSplit = db.prepare(`
      SELECT t.grp, COALESCE(SUM(t.amount_cents),0) AS cents
      FROM transactions t WHERE t.user_id=? AND t.date>=? AND t.date<? AND t.type='expense' AND t.grp IN ('必要','非必要')
      GROUP BY t.grp
    `).all(uid, startMonth, months[0] + '-99');
    const totalExpense = monthInfo.reduce((a, b) => a + b.expense, 0);
    const payload = {
      months: monthInfo,
      topCategories: topCats.map((c) => ({ name: c.name, yuan: centsToYuan(c.cents) })),
      necessaryVsOptional: grpSplit.map((g) => ({ grp: g.grp, yuan: centsToYuan(g.cents) })),
      totalExpense: centsToYuan(Math.round(totalExpense * 100)),
    };
    const sys = '你是一位温暖、懂生活、善于用文字描绘人的财务顾问。基于用户最近几个月的记账统计数据（JSON），' +
      '输出**两段**中文消费洞察，段与段之间用一个空行(\n\n)分隔：' +
      '第一段（约 60-90 字）：用一两句**优美又贴切**的话，勾勒用户的「消费画像」——他大概是怎样生活的人（感性/理性、务实/享受、有没有在为自己投资），' +
      '从数据里看出性格与生活方式，语气温柔、有共鸣、像懂你的朋友。' +
      '第二段（约 60-90 字）：**正经一点的消费分析**——点出最值得注意的 1-2 个消费习惯（数据层面，好的或需改进的），给一条具体可执行的小建议。' +
      '整体像位懂你的朋友在说话，不说教、不掉书袋。只输出这两段正文，不要 markdown 标题、不要列点、不要"我是AI"。';
    const content = await callDeepSeek([{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(payload) }]);
    consumeQuota(req.userId);
    db.prepare('UPDATE users SET last_insight=? WHERE id=?').run(content, req.user.id);
    return json(res, 200, { insight: content, quotaLeft: quota.quota - 1 });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

// 汇总 / 趋势 / 下钻
addRoute('GET', '/api/summary', async (req, res, url) => {
  const month = url.searchParams.get('month') || monthOf(new Date().toISOString());
  return json(res, 200, computeSummary(month, req.userId));
});
addRoute('GET', '/api/trend', async (req, res, url) => {
  const unit = url.searchParams.get('unit') || 'month';
  const n = url.searchParams.get('n') || 12;
  const type = url.searchParams.get('type') === 'income' ? 'income' : 'expense';
  return json(res, 200, computeTrend(unit, n, type, req.userId));
});
addRoute('GET', '/api/category-breakdown', async (req, res, url) => {
  const db = activeDb;
  const month = url.searchParams.get('month') || monthOf(new Date().toISOString());
  const catId = url.searchParams.get('categoryId');
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(note,''), '（无备注）') AS note, COUNT(*) AS cnt, COALESCE(SUM(amount_cents),0) AS cents
    FROM transactions WHERE user_id=? AND strftime('%Y-%m', date) = ? AND type='expense' AND category_id = ?
    GROUP BY note ORDER BY cents DESC LIMIT 12
  `).all(req.userId, month, catId);
  const total = rows.reduce((a, b) => a + b.cents, 0);
  return json(res, 200, rows.map((r) => ({ note: r.note, count: r.cnt, cents: r.cents, yuan: centsToYuan(r.cents), pct: total ? (r.cents / total) * 100 : 0 })));
});

// 交易
addRoute('GET', '/api/transactions', async (req, res, url) => {
  const db = activeDb;
  const month = url.searchParams.get('month') || monthOf(new Date().toISOString());
  const catId = url.searchParams.get('categoryId');
  const sql = `
    SELECT t.id, t.date, t.amount_cents, t.category_id, t.note, t.remark, t.share_kind, t.type, t.channel, t.grp,
           c.name AS category_name, c.color AS category_color
    FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE t.user_id = ? AND strftime('%Y-%m', t.date) = ? ${catId ? 'AND t.category_id = ?' : ''}
    ORDER BY t.date DESC, t.id DESC
  `;
  const rows = catId ? db.prepare(sql).all(req.userId, month, catId) : db.prepare(sql).all(req.userId, month);
  return json(res, 200, rows.map((r) => ({
    id: r.id, date: r.date, amount: centsToYuan(r.amount_cents), amount_cents: r.amount_cents,
    category_id: r.category_id, category: r.category_name, color: r.category_color,
    note: r.note, remark: r.remark || '', share_kind: r.share_kind, type: r.type, channel: r.channel, grp: r.grp,
  })));
});
addRoute('POST', '/api/transactions', async (req, res, url) => {
  const body = await readBody(req);
  const date = String(body.date || '').slice(0, 10);
  const amount = Number(body.amount);
  const type = body.type === 'income' ? 'income' : 'expense';
  if (!date || !Number.isFinite(amount) || amount < 0 || !body.categoryId) return json(res, 400, { error: '缺少日期/金额/类别' });
  if (body.type && body.type !== 'income' && body.type !== 'expense') return json(res, 400, { error: '类型不合法' });
  const catId = Number(body.categoryId);
  if (!db.prepare('SELECT id FROM categories WHERE id=? AND user_id=?').get(catId, req.userId)) return json(res, 400, { error: '类别不存在' });
  const cents = yuanToCents(amount);
  const grp = body.grp === '必要' ? '必要' : '非必要';
  const info = db.prepare(`
    INSERT INTO transactions (date, amount_cents, category_id, note, remark, share_kind, type, channel, grp, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, cents, catId, String(body.note || ''), String(body.remark || ''), String(body.shareKind || ''), type, String(body.channel || ''), grp, req.userId);
  const row = db.prepare('SELECT * FROM transactions WHERE id=?').get(info.lastInsertRowid);
  applyTxnToVault(row, req.userId);
  ensureChild(catId, String(body.note || ''), req.userId);
  return json(res, 200, { ok: true, id: info.lastInsertRowid });
});
addRoute('PUT', '/api/transactions/:id', async (req, res, url, params) => {
  const body = await readBody(req);
  const id = params.id;
  const oldRow = db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
  if (!oldRow) return json(res, 404, { error: '不存在' });
  const date = String(body.date || '').slice(0, 10);
  const amount = Number(body.amount);
  const type = body.type === 'income' ? 'income' : 'expense';
  if (!date || !Number.isFinite(amount) || amount < 0 || !body.categoryId) return json(res, 400, { error: '参数不完整' });
  if (body.type && body.type !== 'income' && body.type !== 'expense') return json(res, 400, { error: '类型不合法' });
  const catId = Number(body.categoryId);
  if (!db.prepare('SELECT id FROM categories WHERE id=? AND user_id=?').get(catId, req.userId)) return json(res, 400, { error: '类别不存在' });
  if (oldRow.user_id !== req.userId) return json(res, 403, { error: '无权操作' });
  reverseTxnFromVault(oldRow, req.userId);
  const grp = body.grp === '必要' ? '必要' : '非必要';
  db.prepare(`
    UPDATE transactions SET date=?, amount_cents=?, category_id=?, note=?, remark=?, share_kind=?, type=?, channel=?, grp=?, user_id=? WHERE id=?
  `).run(date, yuanToCents(amount), catId, String(body.note || ''), String(body.remark || ''), String(body.shareKind || ''), type, String(body.channel || ''), grp, req.userId, id);
  const newRow = db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
  applyTxnToVault(newRow, req.userId);
  ensureChild(catId, String(body.note || ''), req.userId);
  return json(res, 200, { ok: true });
});

// 远期：date > today 的所有交易
addRoute('GET', '/api/future', async (req, res, url) => {
  const db = activeDb;
  const month = url.searchParams.get('month'); // 可选，按月筛选；不传则全未来
  const type = url.searchParams.get('type') === 'income' ? 'income' : (url.searchParams.get('type') === 'expense' ? 'expense' : null);
  const today = new Date().toISOString().slice(0, 10);
  const sqlBase = `
    SELECT t.id, t.date, t.amount_cents, t.category_id, t.note, t.remark, t.share_kind, t.type, t.channel, t.grp,
           c.name AS category_name, c.color AS category_color
    FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE t.user_id=? AND t.date > ? ${type ? 'AND t.type = ?' : ''} ${month ? "AND strftime('%Y-%m', t.date) = ?" : ''}
    ORDER BY t.date ASC, t.id ASC
  `;
  const params = [req.userId, today];
  if (type) params.push(type);
  if (month) params.push(month);
  const rows = db.prepare(sqlBase).all(...params);
  // 7天内即将到期（用于「未入账/待支出」卡片预览数字）
  const soon = rows.filter((r) => {
    const diff = (new Date(r.date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000;
    return diff <= 7;
  });
  return json(res, 200, {
    today,
    list: rows.map((r) => ({ id: r.id, date: r.date, amount: centsToYuan(r.amount_cents), amount_cents: r.amount_cents, category: r.category_name, color: r.category_color, note: r.note, remark: r.remark || '', share_kind: r.share_kind, type: r.type, channel: r.channel, grp: r.grp })),
    soonCount: soon.length,
    soonTotalCents: soon.reduce((a, b) => a + b.amount_cents, 0),
  });
});
// 远期 → 今日入账：date 改为 today（自动触发金库同步）
addRoute('POST', '/api/future/:id/promote', async (req, res, url, params) => {
  const id = params.id;
  const oldRow = db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(id, req.userId);
  if (!oldRow) return json(res, 404, { error: '不存在' });
  const today = new Date().toISOString().slice(0, 10);
  if (oldRow.date <= today) return json(res, 400, { error: '该账目已不是远期' });
  reverseTxnFromVault(oldRow, req.userId);
  db.prepare("UPDATE transactions SET date=? WHERE id=?").run(today, id);
  const newRow = db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
  applyTxnToVault(newRow, req.userId);
  return json(res, 200, { ok: true, date: today });
});
addRoute('DELETE', '/api/transactions/:id', async (req, res, url, params) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(params.id, req.userId);
  if (!row) return json(res, 404, { error: '不存在' });
  reverseTxnFromVault(row, req.userId);
  db.prepare('DELETE FROM transactions WHERE id=?').run(params.id);
  return json(res, 200, { ok: true });
});

// 金库（具体的 order/reset 放前面，避免被 :id 吞掉）
addRoute('GET', '/api/vaults', async (req, res) => {
  const db = activeDb;
  const vaults = db.prepare('SELECT * FROM vaults WHERE user_id=? ORDER BY sort_order, id').all(req.userId);
  const events = db.prepare(`SELECT e.* FROM vault_events e JOIN vaults v ON v.id=e.vault_id WHERE v.user_id=? ORDER BY e.id DESC LIMIT 500`).all(req.userId);
  const un = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE -amount_cents END),0) AS c FROM transactions WHERE user_id=? AND channel=''").get(req.userId);
  const baseline = Number(getSetting('uncat_baseline') || 0);
  const out = vaults.map((v) => ({
    id: v.id, name: v.name, balance: centsToYuan(v.balance_cents), balance_cents: v.balance_cents, updated_at: v.updated_at,
    events: events.filter((e) => e.vault_id === v.id).slice(0, 20).map((e) => ({ id: e.id, delta: centsToYuan(e.delta_cents), after: centsToYuan(e.after_cents), note: e.note, at: e.created_at })),
  }));
  return json(res, 200, { vaults: out, uncategorized: centsToYuan(un.c - baseline) });
});
addRoute('POST', '/api/vaults', async (req, res) => {
  const body = await readBody(req);
  if (!body.name) return json(res, 400, { error: '缺少名称' });
  const ins = db.prepare('INSERT INTO vaults (name, balance_cents, user_id) VALUES (?, ?, ?)').run(String(body.name), yuanToCents(body.balance || 0), req.userId);
  return json(res, 200, { ok: true, id: ins.lastInsertRowid });
});
addRoute('PUT', '/api/vaults/order', async (req, res) => {
  const body = await readBody(req);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  const up = db.prepare('UPDATE vaults SET sort_order=? WHERE id=? AND user_id=?');
  ids.forEach((id, i) => up.run(i, id, req.userId));
  return json(res, 200, { ok: true });
});
addRoute('PUT', '/api/vaults/reset-uncategorized', async (req, res) => {
  const un = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE -amount_cents END),0) AS c FROM transactions WHERE user_id=? AND channel=''").get(req.userId);
  setSetting('uncat_baseline', String(un.c));
  return json(res, 200, { ok: true, uncategorized: 0 });
});
addRoute('PUT', '/api/vaults/:id', async (req, res, url, params) => {
  const body = await readBody(req);
  const v = db.prepare('SELECT * FROM vaults WHERE id=? AND user_id=?').get(params.id, req.userId);
  if (!v) return json(res, 404, { error: '不存在' });
  const newName = body.name != null ? String(body.name) : v.name;
  if (newName !== v.name && db.prepare('SELECT id FROM vaults WHERE name=? AND id<>? AND user_id=?').get(newName, v.id, req.userId)) {
    return json(res, 400, { error: '已有同名资金账户' });
  }
  const newCents = body.balance != null ? yuanToCents(body.balance) : v.balance_cents;
  const delta = newCents - v.balance_cents;
  db.prepare("UPDATE vaults SET name=?, balance_cents=?, updated_at=datetime('now') WHERE id=?").run(newName, newCents, v.id);
  db.prepare('INSERT INTO vault_events (vault_id, delta_cents, after_cents, note, user_id) VALUES (?,?,?,?,?)').run(v.id, delta, newCents, delta === 0 ? '重命名' : '手动调整', req.userId);
  return json(res, 200, { ok: true });
});
// 删除整个资金账户（含其全部明细）
addRoute('DELETE', '/api/vaults/:id', async (req, res, url, params) => {
  const v = db.prepare('SELECT * FROM vaults WHERE id=? AND user_id=?').get(params.id, req.userId);
  if (!v) return json(res, 404, { error: '不存在' });
  db.prepare('DELETE FROM vault_events WHERE vault_id=? AND user_id=?').run(params.id, req.userId);
  db.prepare('DELETE FROM vaults WHERE id=?').run(params.id);
  return json(res, 200, { ok: true });
});
// 删除账目事件：撤销该条 delta 的影响（金库余额 -= delta），并写一条「撤销」记录
addRoute('DELETE', '/api/vault-events/:id', async (req, res, url, params) => {
  const id = params.id;
  db.exec('BEGIN');
  try {
    const ev = db.prepare('SELECT * FROM vault_events WHERE id=? AND user_id=?').get(id, req.userId);
    if (!ev) { db.exec('ROLLBACK'); return json(res, 404, { error: '不存在' }); }
    const v = db.prepare('SELECT * FROM vaults WHERE id=? AND user_id=?').get(ev.vault_id, req.userId);
    if (!v) { db.exec('ROLLBACK'); return json(res, 404, { error: '金库不存在' }); }
    const newBalance = v.balance_cents - ev.delta_cents;
    db.prepare("UPDATE vaults SET balance_cents=?, updated_at=datetime('now') WHERE id=?").run(newBalance, v.id);
    db.prepare('INSERT INTO vault_events (vault_id, delta_cents, after_cents, note, user_id) VALUES (?,?,?,?,?)').run(v.id, -ev.delta_cents, newBalance, '撤销', req.userId);
    db.prepare('DELETE FROM vault_events WHERE id=?').run(id);
    db.exec('COMMIT');
    return json(res, 200, { ok: true });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

// 物件
addRoute('GET', '/api/items', async (req, res) => {
  const db = activeDb;
  const rows = db.prepare('SELECT * FROM items WHERE user_id=? ORDER BY sort_order, id').all(req.userId);
  // v0.2 第五轮：item_events（产生效益 / 额外投入）
  const eventRows = db.prepare("SELECT * FROM item_events WHERE user_id=? ORDER BY event_date DESC, id DESC").all(req.userId);
  const eventsByItem = {};
  for (const e of eventRows) {
    (eventsByItem[e.item_id] = eventsByItem[e.item_id] || []).push({ id: e.id, delta: centsToYuan(e.delta_cents), delta_cents: e.delta_cents, kind: e.kind, note: e.note, event_date: e.event_date, created_at: e.created_at });
  }
  const items = rows.map((r) => {
    const d = new Date(r.purchase_date + 'T00:00:00');
    const days = Math.max(1, Math.floor((Date.now() - d.getTime()) / 86400000) + 1);
    const events = eventsByItem[r.id] || [];
    const eventsTotalCents = events.reduce((a, b) => a + b.delta_cents, 0);
    // 当前价值 = 原金额 - 产生效益 + 额外投入（kind=gain 是负影响，kind=invest 是正影响）
    const currentValueCents = r.amount_cents + eventsTotalCents;
    const amountYuan = centsToYuan(currentValueCents);
    const daily = Math.round((currentValueCents / days) / 100 * 100) / 100;
    return { id: r.id, name: r.name, amount: amountYuan, original_amount: centsToYuan(r.amount_cents), purchase_date: r.purchase_date, days, daily, events };
  });
  const totalValue = Math.round(items.reduce((a, b) => a + b.amount, 0) * 100) / 100;
  const totalDaily = Math.round(items.reduce((a, b) => a + b.daily, 0) * 100) / 100;
  return json(res, 200, { items, totalValue, totalDaily, count: items.length });
});
addRoute('POST', '/api/items', async (req, res) => {
  const body = await readBody(req);
  const name = String(body.name || '').trim();
  const amount = Number(body.amount);
  const date = String(body.purchaseDate || '').slice(0, 10);
  if (!name || !Number.isFinite(amount) || amount < 0 || !date) return json(res, 400, { error: '缺少名称/金额/日期' });
  const nextSort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS s FROM items WHERE user_id=?').get(req.userId).s;
  const info = db.prepare('INSERT INTO items (name, amount_cents, purchase_date, sort_order, user_id) VALUES (?, ?, ?, ?, ?)').run(name, yuanToCents(amount), date, nextSort, req.userId);
  return json(res, 200, { ok: true, id: info.lastInsertRowid });
});
addRoute('PUT', '/api/items/order', async (req, res) => {
  const body = await readBody(req);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  const up = db.prepare('UPDATE items SET sort_order=? WHERE id=? AND user_id=?');
  ids.forEach((id, i) => up.run(i, id, req.userId));
  return json(res, 200, { ok: true });
});
addRoute('PUT', '/api/items/:id', async (req, res, url, params) => {
  const body = await readBody(req);
  db.prepare('UPDATE items SET name=?, amount_cents=?, purchase_date=? WHERE id=? AND user_id=?')
    .run(String(body.name || ''), yuanToCents(Number(body.amount) || 0), String(body.purchaseDate || '').slice(0, 10), params.id, req.userId);
  return json(res, 200, { ok: true });
});
addRoute('DELETE', '/api/items/:id', async (req, res, url, params) => {
  db.prepare('DELETE FROM item_events WHERE item_id=? AND user_id=?').run(params.id, req.userId);
  db.prepare('DELETE FROM items WHERE id=? AND user_id=?').run(params.id, req.userId);
  return json(res, 200, { ok: true });
});
// v0.2 第五轮：物件事件（产生效益/额外投入）
addRoute('POST', '/api/items/:id/events', async (req, res, url, params) => {
  const body = await readBody(req);
  const item = db.prepare('SELECT id FROM items WHERE id=? AND user_id=?').get(params.id, req.userId);
  if (!item) return json(res, 404, { error: '物件不存在' });
  const kind = body.kind === 'gain' ? 'gain' : 'invest';
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: '金额需为正数' });
  const eventDate = String(body.eventDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  // gain(产生效益) → 降低总价值 → delta = -amount
  // invest(额外投入) → 增加总价值 → delta = +amount
  const deltaCents = yuanToCents(kind === 'gain' ? -amount : amount);
  const note = String(body.note || '').trim();
  const info = db.prepare("INSERT INTO item_events (item_id, delta_cents, kind, note, event_date, user_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(params.id, deltaCents, kind, note, eventDate, req.userId);
  return json(res, 200, { ok: true, id: info.lastInsertRowid });
});
addRoute('DELETE', '/api/item-events/:id', async (req, res, url, params) => {
  db.prepare('DELETE FROM item_events WHERE id=? AND user_id=?').run(params.id, req.userId);
  return json(res, 200, { ok: true });
});

// 类别
addRoute('GET', '/api/categories', async (req, res) => json(res, 200, activeDb.prepare('SELECT id, name, kind, grp, color, parent_id FROM categories WHERE user_id=? ORDER BY sort_order, id').all(req.userId)));
addRoute('POST', '/api/categories', async (req, res) => {
  const body = await readBody(req);
  if (!body.name) return json(res, 400, { error: '缺少类别名' });
  const kind = body.kind === 'income' ? 'income' : 'expense';
  const nextSort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS s FROM categories WHERE user_id=?').get(req.userId).s;
  const info = db.prepare('INSERT INTO categories (name, kind, grp, color, parent_id, sort_order, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(body.name), kind, String(body.grp || '非必要'), String(body.color || '#7aa2c4'), body.parent_id ? Number(body.parent_id) : null, nextSort, req.userId);
  if (!body.parent_id) db.prepare("INSERT INTO categories (name, kind, grp, color, parent_id, user_id) VALUES (?, ?, '', '#98a6bd', ?, ?)").run('默认', kind, info.lastInsertRowid, req.userId);
  return json(res, 200, { ok: true, id: info.lastInsertRowid });
});
addRoute('PUT', '/api/categories/order', async (req, res) => {
  const body = await readBody(req);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  const up = db.prepare('UPDATE categories SET sort_order=? WHERE id=? AND user_id=?');
  ids.forEach((id, i) => up.run(i, id, req.userId));
  return json(res, 200, { ok: true });
});
addRoute('PUT', '/api/categories/:id', async (req, res, url, params) => {
  const body = await readBody(req);
  if (!body.name) return json(res, 400, { error: '缺少类别名' });
  if (body.color != null) db.prepare('UPDATE categories SET name=?, color=? WHERE id=? AND user_id=?').run(String(body.name), String(body.color), params.id, req.userId);
  else db.prepare('UPDATE categories SET name=? WHERE id=? AND user_id=?').run(String(body.name), params.id, req.userId);
  return json(res, 200, { ok: true });
});
addRoute('DELETE', '/api/categories/:id', async (req, res, url, params) => {
  const id = params.id;
  const target = db.prepare('SELECT * FROM categories WHERE id=? AND user_id=?').get(id, req.userId);
  if (!target) return json(res, 404, { error: '不存在' });
  const moveToDefault = url.searchParams.get('move') === '1';
  const force = url.searchParams.get('force') === '1';
  if (target.parent_id) {
    const parentId = target.parent_id;
    if (target.name === '默认') {
      db.prepare('DELETE FROM categories WHERE id=?').run(id);
      const rem = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE parent_id=? AND user_id=?').get(parentId, req.userId).n;
      if (rem === 0) ensureDefaultChild(parentId, req.userId);
      return json(res, 200, { ok: true });
    }
    const amountCount = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id=? AND category_id=? AND note=?').get(req.userId, parentId, target.name).n;
    if (amountCount > 0) {
      if (!moveToDefault) return json(res, 409, { error: '该小类已有金额，是否需要归到“默认”下？', needMove: true });
      ensureDefaultChild(parentId, req.userId);
      db.prepare('UPDATE transactions SET note=? WHERE user_id=? AND category_id=? AND note=?').run('默认', req.userId, parentId, target.name);
    }
    db.prepare('DELETE FROM categories WHERE id=?').run(id);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE parent_id=? AND user_id=?').get(parentId, req.userId).n;
    if (remaining === 0) ensureDefaultChild(parentId, req.userId);
    return json(res, 200, { ok: true });
  }
  const nonDefault = db.prepare('SELECT * FROM categories WHERE parent_id=? AND user_id=?').all(id, req.userId).filter((c) => c.name !== '默认');
  if (nonDefault.length > 0) return json(res, 400, { error: '请先删除该大类下的小类（或将其删到只剩「默认」）' });
  const used = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id=? AND category_id=?').get(req.userId, id).n;
  if (used > 0) {
    if (!force) return json(res, 409, { error: '该类别下已有金额，是否连同删除这些账目？', needForce: true });
    db.prepare('DELETE FROM transactions WHERE user_id=? AND category_id=?').run(req.userId, id);
  }
  db.prepare('DELETE FROM categories WHERE parent_id=? AND user_id=?').run(id, req.userId);
  db.prepare('DELETE FROM categories WHERE id=?').run(id);
  return json(res, 200, { ok: true });
});

// 备份 / 导出
addRoute('GET', '/api/backup', async (req, res) => {
  const tmp = path.join(DATA_DIR, 'backup-' + Date.now() + '.db');
  db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  const fname = 'finance-backup-' + new Date().toISOString().slice(0, 10) + '.db';
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + fname + '"', 'Cache-Control': 'no-store' });
  res.end(buf);
});
addRoute('GET', '/api/export-transactions', async (req, res) => {
  const rows = db.prepare(`
    SELECT t.date, t.type, t.amount_cents, c.name AS category, t.note, t.share_kind, t.channel, t.grp
    FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.user_id=? ORDER BY t.date
  `).all(req.userId);
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['日期,类型,金额,类别,备注,分摊,交易方式,必要/非必要'];
  for (const r of rows) lines.push([r.date, r.type, (r.amount_cents / 100).toFixed(2), q(r.category), q(r.note), q(r.share_kind), q(r.channel), q(r.grp)].join(','));
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="transactions.csv"', 'Cache-Control': 'no-store' });
  res.end('\uFEFF' + lines.join('\n'));
});

// 设置
addRoute('GET', '/api/settings', async (req, res) => json(res, 200, { hideAmounts: getSetting('hide_amounts') === '1', hasPassword: !!getSetting('password_hash') }));
addRoute('PUT', '/api/settings', async (req, res) => {
  const body = await readBody(req);
  if (typeof body.hideAmounts === 'boolean') setSetting('hide_amounts', body.hideAmounts ? '1' : '0');
  return json(res, 200, { ok: true });
});
addRoute('PUT', '/api/settings/password', async (req, res) => {
  const body = await readBody(req);
  const pwd = String(body.password || '').trim();
  if (!pwd) db.prepare('DELETE FROM settings WHERE key=?').run('password_hash');
  else {
    if (!/^\d{4}$/.test(pwd) && !/^\d{6}$/.test(pwd)) return json(res, 400, { error: '密码需为 4 位或 6 位数字' });
    setSetting('password_hash', hashPwd(pwd));
  }
  return json(res, 200, { ok: true, hasPassword: !!getSetting('password_hash') });
});
addRoute('POST', '/api/settings/verify', async (req, res) => {
  const body = await readBody(req);
  const h = getSetting('password_hash');
  if (!h) return json(res, 200, { ok: true, noPassword: true });
  return json(res, 200, { ok: hashPwd(body.password || '') === h, hasPassword: true });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  await dispatch(req, res, url);
});

server.listen(PORT, () => {
  console.log(`财务小管家已启动 → http://127.0.0.1:${PORT}`);
});
