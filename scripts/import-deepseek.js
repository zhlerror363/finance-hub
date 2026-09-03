'use strict';
// ===== 从 DeepSeek「核对月度账目」对话导入历史数据 =====
// 用法：node scripts/import-deepseek.js [--dry]
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'finance.db');
const DIALOG = 'E:/DSHWorkspace/deepseek_export/dialogue_月度账目.txt';
const DRY = process.argv.includes('--dry');

// 16 个月（顺序）
const MONTHS = [
  '2025-03','2025-04','2025-05','2025-06','2025-07','2025-08','2025-09','2025-10',
  '2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06',
];

// ---------- 分类映射 ----------
// 顺序很重要：先匹配更具体/易混淆的
const RULES = [
  ['订阅', /(会员|vip|自动扣费|自动续|续费|订阅|夸克|88\s*vip|淘宝\s*88|日记会员|即梦|半年卡|服务卡|服务半年|服务|视频)/i],
  ['氪金', /(氪|游戏|充值|充钱|大月卡|大月|月卡|钻石|皮肤|抽卡|福彩|彩票|刮刮乐|穹|幻塔|立绘|王者|原神|崩坏|steam)/i],
  ['数码', /(耳机|手机|手机壳|手机膜|固态|硬盘|充电|电脑|平板|数码|相机|鼠标|键盘|显示器|耳塞|充电宝|电源)/i],
  ['水电费', /(水费|电费|水卡|燃气|煤气)/],
  ['话费', /(话费|流量|话费充值)/],
  ['交通', /(地铁|公交|单车|打车|高铁|动车|车票|火车|共享|骑行|骑车|电驴|摩托|加油|停车|机票|轮渡|路费|通行证|机场)/i],
  ['学习', /(网课|学习|报|考试|六级|四级|报名|教材|课程|培训|买课|买\s*ppt|ppt|代做|代抄|打印|学费|准考证|付费|书)/i],
  ['社交请客', /(请客|聚餐|聚会|aa|伙伴|请同学|请朋友)/i],
  ['零食饮料', /(奶茶|雪王|古茗|喜茶|瑞幸|咖啡|一点点|coco|茶|饮料|零食|酸奶|水果|香蕉|冰|泡面|巧克力|坚果|牛奶|可乐|脉动|豆奶|豆浆|雪糕|蛋糕|糕点|饼|面包|抹茶|金银花|椰|苏打|^水$)/i],
  ['购物', /(购物|淘宝|京东|拼多多|超市|山姆|天猫|快递|网购|运费|理发|按摩|推拿|健身|洗面|护肤|日用品|干洗|毛巾|纸巾|垃圾袋|鞋套|一次性|沐浴露|泡脚|洗眼|酒精|棉片|牙刷|洗衣|鞋|饰品|药|维生素|眼药)/i],
  ['娱乐', /(娱乐|门票|电影|景区|景点|演出|演唱会|ktv|歌|蹦床|密室|剧本|桌游|游乐|看展|展览|展|乐园|滑雪|影院|剧院|酒店|住宿|青旅|民宿|缆车|观光车|登山|纪念|寄存|缆|登山杖)/i],
  ['三餐', /^(早|中|晚|早餐|午餐|晚餐|早饭|午饭|晚饭)|(饭|面|餐|外卖|食堂|煲|炒|烤|烧|锅|火锅|kfc|麦当劳|达美乐|快餐|麻辣烫|饺子|包子|煎饼|汉堡|螺蛳|米线|塔斯汀|萨莉亚|牛排|鸡排|小吃|菜|排)/],
];

function classify(label) {
  for (const [cat, re] of RULES) if (re.test(label)) return cat;
  return '其他';
}

// ---------- 行解析 ----------
function extractAmount(line) {
  const eq = line.match(/=(-?\d+(?:\.\d+)?)\s*$/);
  if (eq) return { amount: Number(eq[1]), exprEnd: eq.index };
  const num = line.match(/(-?\d+(?:\.\d+)?)\s*$/);
  if (num) return { amount: Number(num[1]), exprEnd: num.index };
  return null;
}

function extractLabel(line) {
  const m = line.trim().match(/^([\u4e00-\u9fa5a-zA-Z]+)/);
  return m ? m[1] : '';
}

const MEAL_RE = /^(早|中|晚|早餐|午餐|晚餐|早饭|午饭|晚饭|中饭)/;
const DATE_RE = /^(\d{1,2})\.(\d{1,2})/;
const SECTION_RE = /^(必要|非必要)支出/;

// 判定日期头：月份须等于当前区块月份，且日期后面不能紧跟算术运算符/续位数字
function isDateHeader(line, monthNum) {
  const m = line.match(DATE_RE);
  if (!m) return null;
  if (Number(m[1]) !== monthNum) return null;
  const after = line[m[0].length];
  if (after !== undefined && (/[+\-*/=]/.test(after) || /[0-9]/.test(after))) return null;
  return m;
}

function parseMonthBlock(block, month, monthNum) {
  const lines = block.split('\n').map((s) => s.trim()).filter(Boolean);
  const txns = [];
  let curDay = 1;
  let pendingGroup = null; // 早月三餐分组（早饭/午饭/晚饭 + 后续算术行）
  let inSkip = false;      // 被请客整组不算支出
  let skipped = 0, unclassified = [], otherLabels = [];

  for (const line of lines) {
    // 被请客整组不算支出
    if (/^被请/.test(line)) { inSkip = true; skipped++; continue; }
    // 跳过元信息/汇总行（总 XXX / 总：…=小计 / 除去… / 年份行）——避免重复记账
    if (/^总/.test(line) || /^除去/.test(line) || /^我的记账/.test(line) || /^\d{4}$/.test(line)) continue;
    const head = isDateHeader(line, monthNum);
    if (head) {
      curDay = parseInt(head[2], 10);
      pendingGroup = null;
      inSkip = false;
      continue;
    }
    if (SECTION_RE.test(line)) { pendingGroup = null; inSkip = false; continue; }
    if (inSkip) continue;
    // 裸三餐分组头（如“早饭”单独一行；兼容“wan饭/中饭/晚飯”等手误）
    if (/^(早饭|午饭|晚饭|中饭|早餐|午餐|晚餐|wan饭|wan飯|中飯|晚飯)$/i.test(line)) { pendingGroup = line; continue; }

    const ex = extractAmount(line);
    if (!ex) continue;
    const label = extractLabel(line) || (pendingGroup || '其他');

    // 被请客不算支出
    if (/被请/.test(label)) { skipped++; continue; }

    const amount = ex.amount;
    if (amount === 0) continue; // 早餐0之类不记

    let category, note;
    if (MEAL_RE.test(label) || (pendingGroup && MEAL_RE.test(label))) {
      category = '三餐';
      note = label.indexOf('早') === 0 ? '早餐' : label.indexOf('中') === 0 ? '午餐' : label.indexOf('晚') === 0 ? '晚餐' : label;
      if (pendingGroup) note = pendingGroup;
    } else {
      category = classify(label);
      note = label;
      if (!category) { unclassified.push(line); category = '其他'; }
      if (category === '其他') otherLabels.push(`${label}|${line}`);
    }

    // 分摊标记
    let share = '';
    const dm = line.match(/\/(\d+(?:\.\d+)?)/);
    if (dm) share = '÷' + dm[1];

    txns.push({ date: `${month}-${String(curDay).padStart(2, '0')}`, amount, category, note, share });
  }
  return { txns, skipped, unclassified, otherLabels };
}

// ---------- 读取对话 & 取数据月份 ----------
const text = fs.readFileSync(DIALOG, 'utf8');
const blocks = text.split(/\n---\n\n/);
const dataBlocks = blocks.filter((b) => {
  if (!/^### \[用户\]/.test(b)) return false;
  return /^总\d/m.test(b) || /^\d{1,2}\.\d{1,2}/m.test(b);
});

if (dataBlocks.length !== MONTHS.length) {
  console.warn(`警告：检测到 ${dataBlocks.length} 个月度数据块，预期 ${MONTHS.length}。`);
}

const allTxns = [];
let totalSkipped = 0;
const unclassAll = [];
const otherAll = [];
const monthSummary = [];

for (let i = 0; i < Math.min(dataBlocks.length, MONTHS.length); i++) {
  const month = MONTHS[i];
  const monthNum = parseInt(month.split('-')[1], 10);
  const { txns, skipped, unclassified, otherLabels } = parseMonthBlock(dataBlocks[i], month, monthNum);
  const dbgIdx = process.argv.indexOf('--dbg');
  const dbgMonth = dbgIdx >= 0 ? process.argv[dbgIdx + 1] : null;
  if (DRY && dbgMonth && month === dbgMonth) {
    console.log(`--- ${month} ${dataBlocks[i].split('\n')[0]} 共 ${txns.length} 笔 ---`);
    for (const t of txns) console.log(`${t.date}  ¥${t.amount}  ${t.category}  ${t.note}`);
  }
  allTxns.push(...txns.map((t) => ({ ...t, month })));
  totalSkipped += skipped;
  unclassAll.push(...unclassified.map((l) => `${month}: ${l}`));
  otherAll.push(...otherLabels.map((l) => `${month}: ${l}`));
  const sum = txns.reduce((a, b) => a + b.amount, 0);
  const claimed = dataBlocks[i].match(/^总\s*([\d,.]+)/m);
  monthSummary.push({
    month, count: txns.length, sum: Math.round(sum * 100) / 100,
    claimed: claimed ? claimed[1] : '-',
  });
}

console.log('==== 月度导入预览 ====');
console.log('月份     笔数   本次合计      原账总(供对照)');
for (const m of monthSummary) {
  console.log(`${m.month}  ${String(m.count).padStart(4)}  ${String(m.sum.toFixed(2)).padStart(10)}    ${m.claimed}`);
}
console.log(`\n共 ${allTxns.length} 笔，金额合计 ${allTxns.reduce((a, b) => a + b.amount, 0).toFixed(2)} 元`);
console.log(`被请客(不计入支出)：${totalSkipped} 笔`);

// 分类分布
const catDist = {};
for (const t of allTxns) catDist[t.category] = (catDist[t.category] || 0) + t.amount;
console.log('\n==== 类别分布 ====');
for (const [c, v] of Object.entries(catDist).sort((a, b) => b[1] - a[1])) {
  console.log(`${c.padEnd(6)} ${v.toFixed(2).padStart(10)}`);
}

// 其他标签频次
const otherCount = {};
for (const s of otherAll) {
  const label = s.split('|')[0];
  otherCount[label] = (otherCount[label] || 0) + 1;
}
console.log('\n==== 落到“其他”的标签 top（需补分类规则/核对）====');
const sortedOther = Object.entries(otherCount).sort((a, b) => b[1] - a[1]);
for (const [label, n] of sortedOther.slice(0, 40)) {
  console.log(`${String(n).padStart(3)}  ${label}`);
}
console.log(`其他标签共 ${sortedOther.length} 种、${otherAll.length} 笔`);

if (unclassAll.length) {
  console.log('\n==== 未分类行 ====');
  console.log(unclassAll.slice(0, 40).join('\n'));
}

// ---------- 写库 ----------
if (DRY) {
  console.log('\n[dry-run] 未写库。');
  process.exit(0);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, kind TEXT DEFAULT 'expense',
    grp TEXT DEFAULT '必要', color TEXT DEFAULT '#7aa2c4'
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL, amount_cents INTEGER NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    note TEXT DEFAULT '', share_kind TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// 确保用到的类别存在
const usedCats = [...new Set(allTxns.map((t) => t.category))];
const getCat = db.prepare('SELECT id FROM categories WHERE name=?');
const insCat = db.prepare('INSERT INTO categories (name, kind, grp, color) VALUES (?, ?, ?, ?)');
const catId = {};
for (const name of usedCats) {
  let row = getCat.get(name);
  if (!row) { insCat.run(name, 'expense', '非必要', '#8f9bb3'); row = getCat.get(name); }
  catId[name] = row.id;
}

const insTx = db.prepare('INSERT INTO transactions (date, amount_cents, category_id, note, share_kind) VALUES (?, ?, ?, ?, ?)');
const clearTx = db.prepare('DELETE FROM transactions');
clearTx.run();
for (const t of allTxns) {
  insTx.run(t.date, Math.round(t.amount * 100), catId[t.category], t.note, t.share);
}

console.log(`\n已写入数据库：${allTxns.length} 笔交易。`);
db.close();
console.log('完成。');
