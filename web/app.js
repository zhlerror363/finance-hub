'use strict';

// ===== 财务小管家 · 前端逻辑 =====
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  month: currentMonth(),
  categories: [],
  vaults: [],
  items: [],
  uncategorized: 0,
  settings: { hideAmounts: false, hasPassword: false },
  detailVaultId: null, // 当前打开的「变动明细」弹窗对应的金库
  locked: true, // 每次进入页面自动上锁
  editingId: null,
  trend: { unit: 'month', n: 12 },
  username: '', // v3 多用户
  isAdmin: false,
  adminUsers: [], // v3 阶段三：admin 可切换查看的用户列表
  viewingUserId: null, // admin 当前查看的用户 id（null=看自己）
  demoMode: false, // v4 模拟模式（数据走后端只读演示库 demo.db）
};

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function masked(v) {
  return state.settings.hideAmounts ? '•••' : v;
}
function maskYuan(v) {
  return state.settings.hideAmounts ? '•••' : '¥' + amountFmt(v);
}
function amountFmt(v) {
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(v) { return `${Math.round(v)}%`; }
const PALETTE = ['#d97a6c', '#5f9ea0', '#8ab77a', '#7aa2c4', '#c98fd6', '#7a7fd6', '#d6b16e', '#c4b77a', '#e0a45e', '#d68a8a', '#9a8ad6', '#6ec4c4', '#6fbf6f', '#e67e22', '#16a085', '#8e44ad', '#2c3e50', '#e74c3c', '#f39c12', '#2980b9', '#1abc9c', '#9b59b6', '#34495e', '#f1c40f', '#e84393', '#00b894', '#636e72'];
function randomColor() {
  const used = new Set(state.categories.map((c) => c.color));
  const avail = PALETTE.filter((c) => !used.has(c));
  return avail.length ? avail[Math.floor(Math.random() * avail.length)] : '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

// v3 多用户：token 鉴权。api() 自动带 Authorization
let stateToken = localStorage.getItem('fh_token') || '';
async function api(path, opts = {}) {
  // v3 阶段三：admin 切换查看某用户时，GET /api 请求自动带 asUserId
  if (state.isAdmin && state.viewingUserId) {
    const sep = path.includes('?') ? '&' : '?';
    if (!opts.method || opts.method === 'GET') path = path + sep + 'asUserId=' + state.viewingUserId;
  }
  // v5 独立演示库：模拟模式走后端 demo.db 只读（GET 走演示库），写操作由后端拒绝
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (stateToken) headers['Authorization'] = 'Bearer ' + stateToken;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error(data.error || '未登录'); }
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// 带 Authorization 下载文件（备份/导出），避免 window.location.href 丢 token 导致 401
async function downloadAuthFile(path, fallbackName) {
  const headers = {};
  if (stateToken) headers['Authorization'] = 'Bearer ' + stateToken;
  const res = await fetch(path, { headers });
  if (res.status === 401) { showLogin(); toast('登录已过期'); return; }
  if (!res.ok) { toast('下载失败（' + res.status + '）'); return; }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="?([^";]+)"?/i);
  const name = (m && m[1]) ? m[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------- 初始化 ----------
function setMonthRange(s) {
  // 可选范围：起点=有数据的最早月份，终点=当前月份（即使当前月无数据也可选）
  const min = s.earliestMonth || currentMonth();
  const max = currentMonth();
  const mp = $('#monthPicker');
  mp.min = min;
  mp.max = max;
  if (state.month < min) state.month = min;
}

// v3 多用户：登录 / 注册
let loginBound = false;
// 密码小眼睛：切换显示/隐藏
function bindPwdEyes() {
  $$('.pwd-eye').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.eye);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.classList.toggle('active');
    });
  });
}
// 密码强度：长度 + 种类 → 弱/中/强
function pwdStrength(pwd) {
  let score = 0;
  if (pwd.length >= 8) score++;
  if (pwd.length >= 12) score++;
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++;
  if (/\d/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  if (score <= 1) return { label: '弱', cls: 'weak' };
  if (score <= 3) return { label: '中', cls: 'mid' };
  return { label: '强', cls: 'strong' };
}
function showRegister() {
  $('#loginModal').classList.add('hidden');
  const rm = $('#registerModal');
  if (rm) { rm.classList.remove('hidden'); $('#regUsername').focus(); }
}
function showLoginModal() {
  const lm = $('#loginModal');
  if (lm) { lm.classList.remove('hidden'); $('#loginUsername').focus(); }
  const rm = $('#registerModal');
  if (rm) rm.classList.add('hidden');
}
function showLogin() {
  const m = $('#loginModal');
  if (m) m.classList.remove('hidden');
  const app = $('.app');
  if (app) app.style.display = 'none';
  $('#loginUsername').focus();
  if (!loginBound) {
    loginBound = true;
    $('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); doAuth('login'); });
    $('#registerForm').addEventListener('submit', (e) => { e.preventDefault(); doRegister(); });
    $('#goRegister').addEventListener('click', (e) => { e.preventDefault(); showRegister(); });
    $('#goLogin').addEventListener('click', (e) => { e.preventDefault(); showLoginModal(); });
    // 密码强度实时提示
    $('#regPassword').addEventListener('input', (e) => {
      const s = pwdStrength(e.target.value);
      const el = $('#regStrength');
      if (el) { el.textContent = '密码强度：' + s.label; el.className = 'pwd-strength ' + s.cls; }
    });
    // 回车关闭注册 modal 的遮罩
    $('#registerModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) showLoginModal(); });
    bindPwdEyes();
  }
}
function hideLogin() {
  const m = $('#loginModal');
  if (m) m.classList.add('hidden');
  const rm = $('#registerModal');
  if (rm) rm.classList.add('hidden');
  const app = $('.app');
  if (app) app.style.display = '';
}
async function doRegister() {
  const username = $('#regUsername').value.trim();
  const password = $('#regPassword').value;
  const password2 = $('#regPassword2').value;
  if (!username || !password) { $('#regError').textContent = '请输入用户名和密码'; return; }
  if (password.length < 6) { $('#regError').textContent = '密码至少 6 位'; return; }
  if (password !== password2) { $('#regError').textContent = '两次密码不一致'; return; }
  $('#regError').textContent = '';
  try {
    const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '注册失败');
    stateToken = data.token; localStorage.setItem('fh_token', stateToken);
    hideLogin();
    location.reload();
  } catch (e) { $('#regError').textContent = e.message; }
}
async function doAuth(mode) {
  const username = $('#loginUsername').value.trim();
  const password = $('#loginPassword').value;
  if (!username || !password) { $('#loginError').textContent = '请输入用户名和密码'; return; }
  $('#loginError').textContent = '';
  try {
    const r = await fetch('/api/auth/' + mode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '操作失败');
    stateToken = data.token; localStorage.setItem('fh_token', stateToken);
    hideLogin();
    location.reload();
  } catch (e) { $('#loginError').textContent = e.message; }
}
function logout() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  stateToken = ''; localStorage.removeItem('fh_token');
  location.reload();
}


// 模拟模式 UI：水印 + 设置页收敛 + 开关状态
function applyDemoUI() {
  // 水印：模拟模式显示
  let wm = $('#demoWatermark');
  if (state.demoMode) {
    if (!wm) { wm = document.createElement('div'); wm.id = 'demoWatermark'; wm.className = 'demo-watermark'; wm.textContent = '当前使用模拟数据'; document.body.appendChild(wm); }
    wm.style.display = 'block';
  } else if (wm) { wm.style.display = 'none'; }
  // 设置页收敛：模拟模式下只显示「模拟模式 + 类别管理」；退出后显示「隐私+类别管理+数据+用户额度+模拟模式」
  const privacy = $('#privacyCard'), data = $('#dataCard');
  const adminCard = $('#adminUsersCard'), demoCard = $('#demoCard'), catCard = $('#catCard');
  const settingsSection = $('#tab-settings');
  if (state.demoMode) {
    // 隐藏其他卡片，只留 类别管理 + 模拟数据（模拟数据移到最前）
    if (privacy) privacy.style.display = 'none';
    if (data) data.style.display = 'none';
    if (adminCard) adminCard.style.display = 'none';
    if (catCard) catCard.style.display = '';
    if (demoCard && settingsSection) settingsSection.insertBefore(demoCard, settingsSection.firstChild);
  } else {
    if (privacy) privacy.style.display = '';
    if (data) data.style.display = '';
    if (adminCard) adminCard.style.display = state.isAdmin ? '' : 'none';
    if (catCard) catCard.style.display = '';
    // 退出模拟模式：把 demoCard 移回末尾（原位）
    if (demoCard && settingsSection) settingsSection.appendChild(demoCard);
  }
  // 模拟模式开关按钮高亮
  const enter = $('#demoEnterBtn'), exit = $('#demoExitBtn');
  if (enter && exit) {
    enter.style.display = state.demoMode ? 'none' : '';
    exit.style.display = state.demoMode ? '' : 'none';
  }
}

// 欢迎弹窗（新用户默认模拟模式）
function showWelcomeModal() {
  const m = $('#welcomeModal');
  if (m) m.classList.remove('hidden');
}
function closeWelcomeModal() {
  const m = $('#welcomeModal');
  if (m) m.classList.add('hidden');
}

// 切换模拟模式（进入/退出），先确认再执行
async function toggleDemoMode(on) {
  const msg = on ? '进入模拟模式？将展示演示数据，你的真实账目不受影响。' : '退出模拟模式？退出后将展示你的真实账目。';
  if (!(await confirmModal(msg, on ? '进入模拟模式' : '退出模拟模式'))) return;
  try {
    await api('/api/demo-mode', { method: 'PUT', body: JSON.stringify({ demoMode: on }) });
    state.demoMode = on;
    applyDemoUI();
    location.reload(); // 简化：退出/进入模拟都整页刷新，重新按模式加载
  } catch (e) { toast(e.message); }
}

// 模拟模式下点记账等被拦截时的提示
function demoBlocked() {
  showToastModal('模拟模式提示', '模拟模式下无法使用该功能，请前往「设置」退出该模式后即可正常记账。');
}

// 简单的提示弹窗
let demoBlockResolve = null;
function showToastModal(title, msg) {
  $('#demoToastTitle').textContent = title;
  $('#demoToastMsg').textContent = msg;
  $('#demoToastModal').classList.remove('hidden');
}
function closeDemoToast() { $('#demoToastModal').classList.add('hidden'); if (demoBlockResolve) { const r = demoBlockResolve; demoBlockResolve = null; r(false); } }

// v3 阶段三：admin 加载用户列表，填「切换查看」下拉
async function loadAdminUsers() {
  const users = await api('/api/admin/users').catch(() => []);
  state.adminUsers = users;
  const sel = $('#userSelect');
  if (!sel) return;
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = ''; opt0.textContent = '（我自己的账）';
  sel.appendChild(opt0);
  users.forEach((u) => {
    const o = document.createElement('option');
    o.value = u.id; o.textContent = u.username + (u.is_admin ? '（管理员）' : '');
    sel.appendChild(o);
  });
}
// v3 阶段三：设置页渲染所有用户 + 额度管理
async function renderAdminUsers() {
  const card = $('#adminUsersCard');
  if (!card) return;
  if (!state.isAdmin) { card.style.display = 'none'; return; }
  card.style.display = '';
  const users = await api('/api/admin/users').catch(() => []);
  const list = $('#adminUsersList');
  list.innerHTML = users.map((u) => `
    <div class="admin-user-row" data-uid="${u.id}">
      <div class="admin-user-name">${esc(u.username)}${u.is_admin ? ' <span class="au-admin">管理员</span>' : ''}</div>
      <div class="admin-user-meta">
        <span class="au-m last-login">上次登录：${u.last_login_at ? esc(u.last_login_at.slice(0, 16)) : '从未'}</span>
        <span class="au-m last-count">登录 ${u.login_count || 0} 次</span>
      </div>
      <div class="admin-user-right">
        <div class="admin-user-quota">AI 剩余：<strong>${u.ai_quota}</strong> 次</div>
        <div class="admin-user-actions">
          <button class="btn ghost small" data-quota-add="10" data-uid="${u.id}">+10</button>
          <button class="btn ghost small" data-quota-add="50" data-uid="${u.id}">+50</button>
          <button class="btn ghost small" data-quota-set="0" data-uid="${u.id}">清零</button>
        </div>
      </div>
    </div>`).join('') || '<span class="muted">暂无用户</span>';
}
async function adminQuotaAdd(uid, add) {
  try {
    const r = await api('/api/admin/users/' + uid + '/quota', { method: 'PUT', body: JSON.stringify({ add }) });
    toast('额度已调整，剩余 ' + r.aiQuota);
    await renderAdminUsers();
  } catch (e) { toast(e.message); }
}
async function adminQuotaSet(uid, set) {
  try {
    const r = await api('/api/admin/users/' + uid + '/quota', { method: 'PUT', body: JSON.stringify({ set }) });
    toast('额度已设置，剩余 ' + r.aiQuota);
    await renderAdminUsers();
  } catch (e) { toast(e.message); }
}

// admin 切换查看某个用户：把 viewingUserId 记录，重新刷新所有数据
async function onUserSwitch() {
  const sel = $('#userSelect'); if (!sel) return;
  const v = sel.value ? Number(sel.value) : null;
  state.viewingUserId = v;
  await refreshAll();
  await loadTrend();
}
// (v3 阶段四：asUserId 已在 api() 里统一追加，无独立函数)

// v3 阶段四：AI 智能记账
let aiPending = []; // 解析出的待确认条目
async function runAIParse() {
  const text = $('#aiText').value.trim();
  if (!text) { $('#aiStatus').textContent = '请先粘贴内容'; return; }
  $('#aiStatus').textContent = 'AI 识别中…';
  $('#aiResult').innerHTML = '';
  try {
    const r = await api('/api/ai/parse', { method: 'POST', body: JSON.stringify({ text }) });
    aiPending = r.items || [];
    $('#aiStatus').textContent = r.items.length ? `识别到 ${r.items.length} 条（${{}}）` : '未识别到条目';
    if (!r.items.length) setParseBtn('parse'); // 没识别到 → 还是「识别」
    renderAIResult();
  } catch (e) { $('#aiStatus').textContent = e.message; setParseBtn('parse'); }
}
// 生成该大类下的小类选项（供 AI 条目小类下拉）
function aiSubOptions(categoryName) {
  const top = state.categories.find((c) => c.name === categoryName && !c.parent_id);
  if (!top) return '<option value="">未分类</option>';
  const kids = state.categories.filter((c) => c.parent_id === top.id);
  const opts = ['<option value="">默认</option>'];
  kids.forEach((k) => opts.push(`<option value="${esc(k.name)}">${esc(k.name)}</option>`));
  return opts.join('');
}
function renderAIResult() {
  const box = $('#aiResult');
  if (!aiPending.length) { box.innerHTML = ''; return; }
  // 该用户的大类（用于让用户在 AI 识别结果里调整大类）
  const tops = state.categories.filter((c) => !c.parent_id);
  box.innerHTML = aiPending.map((it, i) => {
    const isIncome = it.type === 'income';
    const cateList = tops.filter((c) => c.kind === (isIncome ? 'income' : 'expense'));
    return `
    <div class="ai-item" data-idx="${i}">
      <div class="ai-item-line">
        <input type="date" data-f="date" value="${esc(it.date || '')}" />
        <input type="number" data-f="amount" value="${esc(it.amount || '')}" class="ai-amt" />
        <button class="ai-del" data-del="${i}">✕</button>
      </div>
      <div class="ai-item-line">
        <select data-f="type">
          <option value="expense" ${!isIncome ? 'selected' : ''}>支出</option>
          <option value="income" ${isIncome ? 'selected' : ''}>收入</option>
        </select>
        <select data-f="channel">
          <option value="">未分类</option>
          <option value="微信" ${it.channel === '微信' ? 'selected' : ''}>微信</option>
          <option value="支付宝" ${it.channel === '支付宝' ? 'selected' : ''}>支付宝</option>
          <option value="银行卡" ${it.channel === '银行卡' ? 'selected' : ''}>银行卡</option>
          <option value="现金" ${it.channel === '现金' ? 'selected' : ''}>现金</option>
        </select>
      </div>
      <div class="ai-item-line">
        <select data-f="category">
          <option value="">（无大类）</option>
          ${cateList.map((c) => `<option value="${c.name}" ${it.category === c.name ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="ai-item-line">
        <select data-f="note" class="ai-note-select">${aiSubOptions(it.category)}</select>
      </div>
    </div>`}).join('');
  box._bound = false;
  bindAIResultEvents(box);
  setParseBtn('confirm'); // 识别成功 → 右下角「确认保存全部」
}
// 保存 AI 识别出的全部条目（识别成功后右下角「确认保存全部」）
async function saveAIPending() {
  if (!aiPending.length) return;
  try {
    for (const it of aiPending) {
      const cat = state.categories.find((c) => c.name === it.category && !c.parent_id);
      await api('/api/transactions', { method: 'POST', body: JSON.stringify({ date: it.date, amount: Number(it.amount) || 0, type: it.type, categoryId: cat ? cat.id : (state.categories.find((c) => !c.parent_id && c.kind === 'expense')?.id), note: it.note || '', channel: it.channel || '', grp: it.grp || '非必要' }) });
    }
    toast(`已保存 ${aiPending.length} 笔`);
    closeAIModal(); await refreshAll();
  } catch (err) { toast(err.message); }
}
// 切换右下角按钮：识别前 =「✨识别」，识别成功有结果 =「✅确认保存全部」
function setParseBtn(state2) {
  const btn = $('#aiParseGo');
  if (!btn) return;
  if (state2 === 'confirm') {
    btn.textContent = '✅ 确认保存全部';
    btn.dataset.mode = 'confirm';
  } else {
    btn.textContent = '✨ 识别';
    btn.dataset.mode = 'parse';
  }
}
function bindAIResultEvents(box) {
  if (box._bound) return; box._bound = true;
  box.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { aiPending.splice(Number(del.dataset.del), 1); renderAIResult(); return; }
  });
  box.addEventListener('change', (e) => {
    const row = e.target.closest('.ai-item');
    if (!row) return;
    const idx = Number(row.dataset.idx);
    const f = e.target.dataset.f;
    if (!f) return;
    aiPending[idx][f] = e.target.value;
    // 改变类型 → 大类列表也要按支出/收入刷新；改变大类 → 小类下拉联动刷新
    if (f === 'type') {
      const isIncome = e.target.value === 'income';
      const tops = state.categories.filter((c) => !c.parent_id && c.kind === (isIncome ? 'income' : 'expense'));
      const catSel = row.querySelector('[data-f="category"]');
      catSel.innerHTML = '<option value="">（无大类）</option>' + tops.map((c) => `<option value="${c.name}">${esc(c.name)}</option>`).join('');
      if (!tops.some((c) => c.name === aiPending[idx].category)) aiPending[idx].category = '';
      catSel.value = aiPending[idx].category || '';
      const noteSel = row.querySelector('[data-f="note"]');
      noteSel.innerHTML = aiSubOptions(aiPending[idx].category);
      aiPending[idx].note = '';
    } else if (f === 'category') {
      const catName = e.target.value;
      const noteSel = row.querySelector('[data-f="note"]');
      noteSel.innerHTML = aiSubOptions(catName);
      aiPending[idx].note = '';
      // 若大类变了，把 note 清空（因为小类属于新的大类）
      noteSel.value = '';
    }
  });
}
function closeAIModal() { $('#aiModal').classList.add('hidden'); }
function openAIModal() { $('#aiModal').classList.remove('hidden'); $('#aiText').value = ''; $('#aiStatus').textContent = ''; $('#aiResult').innerHTML = ''; aiPending = []; setParseBtn('parse'); }

// v3 阶段四：AI 消费洞察
// 渲染 AI 洞察两段文字（优美画像 + 正经分析，用 \n\n 分隔）
function renderInsightText(box, insight) {
  if (!box) return;
  const parts = String(insight || '').split(/\n\s*\n/).filter((s) => s.trim());
  let html = '';
  if (parts.length >= 2) {
    html = '<div class="ai-insight-text ai-insight-gentle">' + esc(parts[0].trim()) + '</div>' +
           '<div class="ai-insight-text ai-insight-analysis">' + esc(parts[1].trim()) + '</div>';
  } else if (parts.length === 1) {
    html = '<div class="ai-insight-text">' + esc(parts[0].trim()) + '</div>';
  } else {
    html = '<div class="ai-insight-text">' + esc(insight) + '</div>';
  }
  box.innerHTML = html;
}
// 设置普通用户看到的「AI 额度」显示（剩余次数）
function setAiQuota(n) {
  const el = $('#aiQuota');
  if (!el) return;
  el.textContent = (n === undefined || n === null) ? '' : `AI额度：${n} 次`;
}
async function runAIInsight() {
  const box = $('#aiInsightBox');
  if (!box) return;
  box.textContent = 'AI 分析中…';
  try {
    const r = await api('/api/ai/insight', { method: 'POST', body: '{}' });
    // 拆成两段：第一段优美画像，第二段正经分析（用空行 \n\n 分隔）
    renderInsightText(box, r.insight);
    // 生成洞察消耗一次额度，刷新剩余显示
    if (typeof r.quotaLeft === 'number') setAiQuota(r.quotaLeft);
  } catch (e) { box.textContent = e.message; }
}

async function init() {
  // v3 多用户：先检查登录态，未登录 → 显示登录页
  if (!stateToken) { showLogin(); return; }
  const me = await api('/api/auth/me').catch(() => null);
  if (!me) { showLogin(); return; }
  state.username = me.username;
  state.isAdmin = me.isAdmin;
  state.myUserId = me.id;
  state.demoMode = !!me.demoMode;
  $('#monthPicker').value = state.month;
  $('#txDate').value = new Date().toISOString().slice(0, 10);
  $('#accountInfo').textContent = me.username;
  // v4 洞察保留：若上次生成了 AI 消费洞察，登录/刷新后重新显示
  if (me.lastInsight) renderInsightText($('#aiInsightBox'), me.lastInsight);
  // v5 普通用户显示自己的 AI 剩余额度
  setAiQuota(me.aiQuota);

  applyDemoUI();
  // v4 模拟模式：默认给新用户看欢迎弹窗（若还未关闭过）
  if (state.demoMode && !localStorage.getItem('fh_demo_welcomed')) {
    showWelcomeModal();
    localStorage.setItem('fh_demo_welcomed', '1');
  }
  // v3 阶段三：admin 专属用户切换器 + 额度管理
  if (state.isAdmin) {
    $('#userSelectWrap').style.display = '';
    await loadAdminUsers();
    await renderAdminUsers();
  } else {
    $('#userSelectWrap').style.display = 'none';
  }
  await loadCategories();
  await loadSettings();
  updateLockBtn(); // 进入页面自动上锁
  renderGrpForm('expense', 'tx');
  renderGrpForm('expense', 'edit');
  // 默认：当前月无数据则跳到有数据的最新月；之后用户可自由切到任意月（含空的）
  const s0 = await api(`/api/summary?month=${state.month}`);
  setMonthRange(s0);
  if (s0.total === 0 && s0.latestMonth && s0.latestMonth !== state.month) {
    state.month = s0.latestMonth;
    $('#monthPicker').value = s0.latestMonth;
  }
  await refreshAll();
  await loadTrend();
  fillChannelOptions();
  bindEvents();
  applyTheme(localStorage.getItem('theme') || 'light');
}

async function refreshAll() {
  await Promise.all([loadSummary(), loadTransactions(), loadVaults(), loadItems(), loadFuture()]);
  // 不再自动跳月：用户切到空月份也应停留，显示 0 / 暂无数据
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  $('#hideAmounts').checked = state.settings.hideAmounts;
  $('#eyeBtn').textContent = state.settings.hideAmounts ? '🙈' : '👁️';
}

async function loadCategories() {
  state.categories = await api('/api/categories');
  renderCategorySelects();
  renderCategories();
}
function renderCategorySelects() {
  const expense = state.categories.filter((c) => c.kind === 'expense');
  const income = state.categories.filter((c) => c.kind === 'income');
  const catSel = (el, all) => {
    el.innerHTML = '';
    if (all) el.innerHTML = '<option value="">无</option>';
    all.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; el.appendChild(o); });
  };
  catSel($('#txCategory'), expense);
  catSel($('#editCategory'), state.categories.filter((c) => !c.parent_id));
  refreshTypeCategory();
  populateLedgerFilter();
  fillNoteSelect('tx');
  fillNoteSelect('edit');
}

function populateLedgerFilter() {
  const sel = $('#ledgerFilter'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部</option>' + state.categories.filter((c) => !c.parent_id && c.kind === 'expense').map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = cur || '';
}

// v0.2 第七轮：小类改为 select（下拉换选项）＋「自定义」输入。填充大类下小类。
function fillNoteSelect(scope) {
  // scope='tx'|'edit'。依据对应的类别下拉当前值（大类 id）填充小类 select。
  const catSel = scope === 'edit' ? $('#editCategory') : $('#txCategory');
  const noteSel = scope === 'edit' ? $('#editNote') : $('#txNote');
  const custom = scope === 'edit' ? $('#editNoteCustom') : $('#txNoteCustom');
  if (!catSel || !noteSel) return;
  const pid = Number(catSel.value);
  noteSel.innerHTML = '';
  const kids = state.categories.filter((c) => c.parent_id === pid);
  // 空 option 显示「默认」（若有真实「默认」小类会优先）——主人要求小类默认显示「默认」
  const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '默认'; noteSel.appendChild(o0);
  kids.forEach((k) => { const o = document.createElement('option'); o.value = k.name; o.textContent = k.name; noteSel.appendChild(o); });
  const oc = document.createElement('option'); oc.value = '__custom__'; oc.textContent = '＋ 自定义…'; noteSel.appendChild(oc);
  // 默认选「默认」项（值为空的那个），除非已有选中值
  const cur = noteSel.dataset.cur || '';
  noteSel.value = cur || '';
  toggleNoteCustom(scope);
}
function toggleNoteCustom(scope) {
  const noteSel = scope === 'edit' ? $('#editNote') : $('#txNote');
  const custom = scope === 'edit' ? $('#editNoteCustom') : $('#txNoteCustom');
  if (!noteSel || !custom) return;
  if (noteSel.value === '__custom__') { custom.style.display = ''; custom.focus(); }
  else { custom.style.display = 'none'; }
}
function noteVal(scope) {
  const noteSel = scope === 'edit' ? $('#editNote') : $('#txNote');
  const custom = scope === 'edit' ? $('#editNoteCustom') : $('#txNoteCustom');
  if (noteSel.value === '__custom__') return custom.value.trim();
  return noteSel.value;
}

async function loadTransactions() {
  const catFilter = $('#ledgerFilter')?.value || '';
  const rows = await api(`/api/transactions?month=${state.month}${catFilter ? '&categoryId=' + catFilter : ''}`);
  $('#ledgerTitle').textContent = `${state.month} 账目（${rows.length} 笔）`;
  const list = $('#txList');
  if (!rows.length) { list.innerHTML = '<div class="empty">这个月还没有账目，先在左边记一笔吧～</div>'; return; }
  list.innerHTML = rows.map((t) => {
    const sign = t.type === 'income' ? '+' : '-';
    const cls = t.type === 'income' ? 'income' : '';
    return `
    <div class="tx-item" data-edit="${t.id}">
      <span class="tx-dot" style="background:${esc(t.color)}"></span>
      <div class="tx-main">
        <div class="tx-name">${esc(t.category)} <span class="tag">${esc(t.channel || '未分类')}</span> ${t.type !== 'income' ? `<span class="tag grp">${esc(t.grp)}</span>` : ''}</div>
        <div class="tx-meta">${esc(t.date.slice(2))} · ${esc(t.note || '—')} ${t.share_kind ? esc(t.share_kind) : ''}</div>
      </div>
      <div class="tx-amt ${cls}">${sign}${maskYuan(t.amount)}</div>
    </div>`;
  }).join('');
}

async function loadSummary() {
  const s = await api(`/api/summary?month=${state.month}`);
  renderStats(s);
  renderGroupDonut(s.groups);
  renderCatDonut(s.categories.filter((c) => c.cents > 0));
  renderIncomeDonut(s.incomeCategories || []);
  return s;
}

function renderStats(s) {
  const grid = $('#statGrid');
  const stats = [
    { label: `${s.month} 支出`, value: maskYuan(s.total) },
    { label: '收入', value: '+ ' + maskYuan(s.income) },
    { label: '结余', value: (s.net >= 0 ? '' : '') + maskYuan(s.net) },
    { label: '笔数', value: s.count },
  ];
  grid.innerHTML = stats.map((st) => `<div class="stat"><div class="label">${esc(st.label)}</div><div class="value">${st.value}</div></div>`).join('');
}

// ---------- SVG 图表 ----------
function svgEl(w, h) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  return svg;
}
function pt(cx, cy, r, deg) { const rad = deg * Math.PI / 180; return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }; }

function renderDonut(container, slices, centerLabel) {
  const total = slices.reduce((a, b) => a + b.value, 0);
  container.innerHTML = '';
  if (!total || !slices.length) { container.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const size = 200, r = 78, cx = size / 2, cy = size / 2, stroke = 30;
  const svg = svgEl(size, size);
  let angle = -90;
  slices.forEach((sl) => {
    const frac = sl.value / total;
    const a0 = angle, a1 = angle + frac * 360; angle = a1;
    if (frac <= 0) return;
    // 单一分类占满100%时，SVG 的 A 命令画一整圆会退化成点——用 circle 画整圆更稳
    if (frac >= 0.9999) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', cx); circle.setAttribute('cy', cy); circle.setAttribute('r', r);
      circle.setAttribute('fill', 'none'); circle.setAttribute('stroke', sl.color); circle.setAttribute('stroke-width', stroke);
      svg.appendChild(circle);
      return;
    }
    const large = a1 - a0 > 180 ? 1 : 0;
    const p0 = pt(cx, cy, r, a0), p1 = pt(cx, cy, r, a1);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`);
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', sl.color); path.setAttribute('stroke-width', stroke);
    svg.appendChild(path);
  });
  if (centerLabel) {
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', cx); txt.setAttribute('y', cy + 4); txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('font-size', '22'); txt.setAttribute('font-weight', '700'); txt.setAttribute('fill', 'var(--text)');
    txt.textContent = centerLabel;
    svg.appendChild(txt);
  }
  container.appendChild(svg);
  const lg = document.createElement('div'); lg.className = 'legend';
  slices.forEach((sl) => {
    const li = document.createElement('div'); li.className = 'li';
    li.innerHTML = `<span class="swatch" style="background:${esc(sl.color)}"></span>${esc(sl.label)} ${pct(sl.value / total * 100)}`;
    lg.appendChild(li);
  });
  container.appendChild(lg);
}

function renderGroupDonut(groups) {
  const slices = groups.map((g) => ({ label: g.grp, value: g.cents, color: g.grp === '必要' ? '#6fbf6f' : '#d68a8a' }));
  renderDonut($('#groupChart'), slices, '');
}
function renderIncomeDonut(cats) {
  const slices = cats.filter((c) => c.cents > 0).map((c) => ({ label: c.name, value: c.cents, color: c.color }));
  renderDonut($('#incCatChart'), slices, '');
}
function renderCatDonut(cats) {
  const slices = cats.map((c) => ({ id: c.id, label: c.name, value: c.cents, color: c.color }));
  const total = cats.reduce((a, b) => a + b.cents, 0);
  renderAnnotatedDonut($('#catChart'), slices, total);
  renderCatLegendList(cats);
  attachDrill($('#catChart'), slices);
}

function renderCatLegendList(cats) {
  const total = cats.reduce((a, b) => a + b.cents, 0);
  $('#catLegendList').innerHTML = cats.map((c) => `
    <div class="cat-li" data-cat="${c.id}">
      <span class="swatch" style="background:${esc(c.color)}"></span>
      <span class="cl-name">${esc(c.name)}</span>
      <span class="cl-pct">${pct(c.cents / total * 100)}</span>
    </div>`).join('');
}

// 在圆环内画「引出线 + 标注」，替代下方列表
function renderAnnotatedDonut(container, slices, total) {
  container.innerHTML = '';
  if (!total || !slices.length) { container.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const w = 440, h = 360, cx = w / 2, cy = h / 2;
  const r = 76, stroke = 28, R = r + stroke / 2 + 4, LR = r + stroke / 2 + 34;
  const svg = svgEl(w, h);
  let angle = -90;
  slices.forEach((sl) => {
    const frac = sl.value / total;
    const a0 = angle, a1 = angle + frac * 360; angle = a1;
    if (frac <= 0) return;
    const large = a1 - a0 > 180 ? 1 : 0;
    const p0 = pt(cx, cy, R, a0), p1 = pt(cx, cy, R, a1);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${p0.x} ${p0.y} A ${R} ${R} 0 ${large} 1 ${p1.x} ${p1.y}`);
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', sl.color); path.setAttribute('stroke-width', stroke);
    svg.appendChild(path);
  });
  angle = -90;
  slices.forEach((sl, idx) => {
    const frac = sl.value / total;
    const mid = angle + frac * 360 / 2; angle += frac * 360;
    if (idx >= 5 || frac * 100 < 5) return; // 默认前五名，且占比 ≥5% 才拉出
    const rad = mid * Math.PI / 180;
    const ox = cx + R * Math.cos(rad), oy = cy + R * Math.sin(rad);
    const lx = cx + LR * Math.cos(rad), ly = cy + LR * Math.sin(rad);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', ox); line.setAttribute('y1', oy); line.setAttribute('x2', lx); line.setAttribute('y2', ly);
    line.setAttribute('stroke', sl.color); line.setAttribute('stroke-width', '1.5');
    svg.appendChild(line);
    const anchor = Math.cos(rad) >= 0 ? 'start' : 'end';
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', lx + (anchor === 'start' ? 4 : -4)); txt.setAttribute('y', ly + 4);
    txt.setAttribute('text-anchor', anchor); txt.setAttribute('font-size', '11'); txt.setAttribute('fill', 'var(--text)');
    txt.textContent = `${sl.label} ${pct(frac * 100)}`;
    svg.appendChild(txt);
  });
  container.appendChild(svg);
}

function attachDrill(container, slices) {
  if (!slices || !slices.length) return;
  const paths = [...container.querySelectorAll('svg path')];
  const listItems = [...document.querySelectorAll('#catLegendList .cat-li')];
  const wrap = (el, sl) => {
    if (!el || !sl || !sl.id) return;
    el.style.cursor = 'pointer';
    el.addEventListener('mouseenter', () => showDrill(sl.id, sl.label));
    el.addEventListener('click', (e) => { e.preventDefault(); showDrill(sl.id, sl.label, true); });
  };
  slices.forEach((sl, i) => wrap(paths[i], sl));
  listItems.forEach((el) => wrap(el, slices.find((x) => String(x.id) === el.dataset.cat)));
}

let drillPinned = false, drillPinnedCat = null;
async function showDrill(catId, name, sticky = false) {
  if (drillPinned && !sticky) return; // 已固定，悬停其他不回变
  if (sticky) {
    drillPinned = drillPinnedCat === catId ? false : true;
    drillPinnedCat = drillPinned ? catId : null;
    if (!drillPinned) { $('#drillPop').innerHTML = '<div class="drill-empty">悬停看细分<br>点击固定</div>'; return; }
  }
  const data = await api(`/api/category-breakdown?month=${state.month}&categoryId=${catId}`);
  $('#drillPop').innerHTML = `<div class="drill-title">${esc(name)} · 细分</div>` + data.map((d) => `
    <div class="drill-row"><span class="drill-note">${esc(d.note)}</span><span class="drill-val">${maskYuan(d.yuan)} · ${d.pct.toFixed(1)}%</span></div>
  `).join('');
}
function hideDrill() { if (!drillPinned) $('#drillPop').innerHTML = '<div class="drill-empty">悬停看细分<br>点击固定</div>'; }

// ---------- 全局提示（ⓘ） ----------
function showGlobalTip(anchor, tipText) {
  let tip = $('#globalTip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'globalTip'; tip.className = 'global-tip'; document.body.appendChild(tip); }
  const segs = String(tipText || '').split('|');
  const title = (segs[0] || '').replace(/^title:/, '');
  const content = (segs[1] || '').replace(/^content:/, '');
  tip.innerHTML = `<strong>${esc(title)}</strong><p>${esc(content)}</p>`;
  const r = anchor.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - 260, r.left) + 'px';
  tip.style.top = (r.bottom + 6) + 'px';
  tip.classList.add('show');
}
function hideGlobalTip() { const tip = $('#globalTip'); if (tip) tip.classList.remove('show'); }

function showChartTip(e, html) {
  let tip = $('#chartTip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'chartTip'; tip.className = 'chart-tip'; document.body.appendChild(tip); }
  tip.innerHTML = html;
  tip.style.left = Math.min(window.innerWidth - 200, e.clientX + 14) + 'px';
  tip.style.top = (e.clientY - 10) + 'px';
  tip.classList.add('show');
}
function hideChartTip() { const tip = $('#chartTip'); if (tip) tip.classList.remove('show'); }

// ---------- 通用确认弹窗 / 轻提示 ----------
let confirmResolve = null;
let unlockResolver = null;
function updateLockBtn() {
  const b = $('#lockBtn');
  if (b) b.textContent = state.locked ? '🔒 已锁定' : '🔓 已解锁';
}
async function requireUnlock() {
  if (!state.locked) return true;
  if (!state.settings.hasPassword) return true; // 未设密码则无锁，不拦截
  $('#pwdModal').classList.remove('hidden');
  $('#pwdCheck').value = '';
  $('#pwdCheck').focus();
  return new Promise((resolve) => { unlockResolver = resolve; });
}
function confirmModal(message, title = '确认') {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = message;
    $('#confirmModal').classList.remove('hidden');
  });
}
function closeConfirm(result) {
  $('#confirmModal').classList.add('hidden');
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- 趋势 ----------
function niceAxis(maxVal, ticks = 5) {
  if (maxVal <= 0) return { max: 0, step: 0 };
  const rough = maxVal / ticks;
  const exp = Math.floor(Math.log10(rough));
  const f = rough / Math.pow(10, exp);
  let step;
  if (f <= 1) step = 1; else if (f <= 2) step = 2; else if (f <= 2.5) step = 2.5; else if (f <= 5) step = 5; else step = 10;
  step = step * Math.pow(10, exp);
  const max = Math.ceil(maxVal / step) * step;
  return { max, step };
}

function renderGrowth(mom, yoy, containerId = '#growthBar') {
  const bar = $(containerId); if (!bar) return;
  if (mom === null && yoy === null) { bar.innerHTML = ''; return; }
  const chip = (label, v) => {
    if (v === null) return `<div class="chip">${label} —</div>`;
    const sign = v >= 0 ? '+' : '-';
    return `<div class="chip ${v >= 0 ? 'up' : 'down'}">${label} ${sign}${Math.abs(v).toFixed(1)}%</div>`;
  };
  bar.innerHTML = chip('环比', mom) + chip('同比', yoy);
}

async function loadTrend() {
  const t = state.trend;
  const base = `/api/trend?unit=${t.unit}&n=${t.n}`;
  const [exp, inc] = await Promise.all([api(base + '&type=expense'), api(base + '&type=income')]);
  renderGrowth(exp.mom, exp.yoy, '#growthBar');
  renderGrowth(inc.mom, inc.yoy, '#incGrowthBar');
  renderTrend(exp, '#trendChart');
  renderTrend(inc, '#incTrendChart');
}
function onTrendCustom() {
  const n = Number($('#trendNum').value);
  if (!n || n <= 0) return;
  state.trend = { unit: $('#trendUnit').value, n };
  $$('.seg-btn').forEach((x) => x.classList.remove('active'));
  loadTrend();
}

function renderTrend(data, containerId = '#trendChart') {
  const container = $(containerId);
  container.innerHTML = '';
  const labels = data.labels, values = data.values.map((v) => v / 100); // cents -> yuan
  if (!values.length || values.every((v) => v === 0)) { container.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const maxVal = Math.max(...values, 0);
  const { max, step } = niceAxis(maxVal);
  const ticks = step > 0 ? Math.round(max / step) : 0;
  const hide = state.settings.hideAmounts;
  const w = Math.max(820, labels.length * 30), h = 250, padL = 60, padB = 34, padT = 20, padR = 20;
  const plotH = h - padB - padT, plotW = w - padL - padR;
  const svg = svgEl(w, h);

  // 网格横线 + y 轴标签
  for (let i = 0; i <= ticks; i++) {
    const yv = (max / ticks) * i;
    const y = padT + plotH - (yv / max) * plotH;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padL); line.setAttribute('x2', w - padR);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--border)'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
    if (!hide) {
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', padL - 8); txt.setAttribute('y', y + 4);
      txt.setAttribute('text-anchor', 'end'); txt.setAttribute('font-size', '11'); txt.setAttribute('fill', 'var(--muted)');
      txt.textContent = Math.round(yv) + '';
      svg.appendChild(txt);
    }
  }

  const bw = Math.max(2, plotW / labels.length - 6);
  labels.forEach((lab, i) => {
    const v = values[i];
    const bh = max > 0 ? (v / max) * plotH : 0;
    const x = padL + i * (plotW / labels.length) + (plotW / labels.length - bw) / 2;
    const y = padT + plotH - bh;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x); rect.setAttribute('y', y); rect.setAttribute('width', bw); rect.setAttribute('height', bh);
    rect.setAttribute('rx', 4); rect.setAttribute('fill', 'var(--accent)');
    svg.appendChild(rect);
    rect.style.cursor = 'pointer';
    const momv = data.moms ? data.moms[i] : null;
    const yoyv = data.yoys ? data.yoys[i] : null;
    let barHtml = `<strong>${esc(lab)}</strong><p>${maskYuan(v)}</p>`;
    if (momv !== null) barHtml += `<p class="tip-g">环比 ${momv >= 0 ? '+' : '-'}${Math.abs(momv).toFixed(1)}%</p>`;
    if (yoyv !== null) barHtml += `<p class="tip-g">同比 ${yoyv >= 0 ? '+' : '-'}${Math.abs(yoyv).toFixed(1)}%</p>`;
    // 整列透明命中区：从高到低滑动都能触发提示
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hit.setAttribute('x', padL + i * (plotW / labels.length));
    hit.setAttribute('y', padT); hit.setAttribute('width', plotW / labels.length); hit.setAttribute('height', plotH);
    hit.setAttribute('fill', 'transparent');
    hit.style.cursor = 'pointer';
    hit.addEventListener('mouseenter', (e) => showChartTip(e, barHtml));
    hit.addEventListener('mousemove', (e) => showChartTip(e, barHtml));
    hit.addEventListener('mouseleave', hideChartTip);
    svg.appendChild(hit);
    const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lbl.setAttribute('x', x + bw / 2); lbl.setAttribute('y', h - 12); lbl.setAttribute('text-anchor', 'middle');
    lbl.setAttribute('font-size', '10'); lbl.setAttribute('fill', 'var(--muted)');
    lbl.textContent = lab;
    svg.appendChild(lbl);
  });
  container.appendChild(svg);
}

// ---------- 金库 ----------
async function loadVaults() {
  const data = await api('/api/vaults');
  state.vaults = data.vaults || [];
  state.uncategorized = data.uncategorized || 0;
  renderVaults();
}
async function loadItems() {
  const data = await api('/api/items');
  state.items = data.items || [];
  renderItemStats(data);
  renderItemGrid();
}
function renderItemStats(data) {
  $('#itemStats').innerHTML = `
    <div class="vault-card no-hover"><div class="vault-head"><span class="vault-name">总价值</span></div><div class="vault-balance">${maskYuan(data.totalValue)}</div><div class="vault-events"><div class="ve muted">全部物件价值</div></div></div>
    <div class="vault-card no-hover"><div class="vault-head"><span class="vault-name">总日均</span></div><div class="vault-balance">${maskYuan(data.totalDaily)}</div><div class="vault-events"><div class="ve muted">全部物件日均成本</div></div></div>
    <div class="vault-card no-hover"><div class="vault-head"><span class="vault-name">物品数</span></div><div class="vault-balance">${data.count}</div><div class="vault-events"><div class="ve muted">登记物件数量</div></div></div>`;
}
function renderItemGrid() {
  const grid = $('#itemGrid');
  grid.innerHTML = state.items.map((it) => `
    <div class="vault-card item-card" data-id="${it.id}">
      <div class="vault-head"><span class="vault-name">${esc(it.name)}</span><div class="vi"><button title="删除" data-itemdel="${it.id}">🗑️</button></div></div>
      <div class="vault-balance">${maskYuan(it.amount)}</div>
      <div class="vault-events">
        <div class="ve"><span class="ve-note">购置 ${esc(it.purchase_date)}</span></div>
        <div class="ve"><span class="ve-note">已用 ${it.days} 天</span><span class="ve-d">${maskYuan(it.daily)}/天</span></div>
      </div>
    </div>`).join('');
}

function renderVaults() {
  const grid = $('#vaultGrid');
  const total = state.vaults.reduce((a, b) => a + b.balance, 0);
  $('#vaultStats').innerHTML = `
    <div class="vault-card no-hover"><div class="vault-head"><span class="vault-name">总资产</span></div><div class="vault-balance">${maskYuan(total)}</div><div class="vault-events"><div class="ve muted">全部资金合计</div></div></div>
    <div class="vault-card no-hover"><div class="vault-head"><span class="vault-name">未分类</span></div><div class="vault-balance">${maskYuan(state.uncategorized)}</div><div class="vault-events"><div class="ve muted">未指定交易方式</div></div></div>`;
  grid.innerHTML = state.vaults.map((v) => `
    <div class="vault-card${v.balance < 0 ? ' neg' : ''}" data-vault="${v.id}">
      <div class="vault-head">
        <span class="vault-name">${esc(v.name)}</span>
        <div class="vi">
          <button title="修改金额" data-vaultedit="${v.id}">✏️</button>
        </div>
      </div>
      <div class="vault-balance">${maskYuan(v.balance)}</div>
      <div class="vault-events">
        ${v.events.length ? v.events.slice(0, 4).map((e) => `
          <div class="ve"><span class="ve-note">${esc(e.note)}</span><span class="ve-d">${e.delta >= 0 ? '+' : ''}${maskYuan(e.delta)} → ${maskYuan(e.after)}</span></div>
        `).join('') : '<div class="ve muted">暂无变动</div>'}
      </div>
    </div>
  `).join('');
}
// 注：点金库卡片本体 = 打开变动明细弹窗；点 ✏️ = 打开修改金额弹窗（含删除按钮）

// ---------- 远期 ----------
async function loadFuture() {
  const [inc, exp] = await Promise.all([api('/api/future?type=income'), api('/api/future?type=expense')]);
  state.future = { income: inc, expense: exp };
  renderFuture();
}
function renderFuture() {
  const inc = state.future?.income || { list: [], soonTotalCents: 0, soonCount: 0 };
  const exp = state.future?.expense || { list: [], soonTotalCents: 0, soonCount: 0 };
  // 最近一笔：按日期升序第一个
  const nextOf = (list) => list.length ? `${list[0].date.slice(5)} · ${list[0].category}${list[0].note ? ' · ' + list[0].note : ''} ${list[0].type === 'income' ? '+' : '-'}${maskYuan(list[0].amount)}` : '暂无';
  $('#futureStats').innerHTML = `
    <div class="vault-card future-card" data-future-type="income" title="点击查看明细">
      <div class="vault-head"><span class="vault-name">未入账</span><span class="future-soon">7天内 ${inc.soonCount} 笔</span></div>
      <div class="vault-balance">${maskYuan(inc.soonTotalCents / 100)}</div>
      <div class="vault-events"><div class="ve">${esc(nextOf(inc.list))}</div></div>
    </div>
    <div class="vault-card future-card" data-future-type="expense" title="点击查看明细">
      <div class="vault-head"><span class="vault-name">待支出</span><span class="future-soon">7天内 ${exp.soonCount} 笔</span></div>
      <div class="vault-balance">${maskYuan(exp.soonTotalCents / 100)}</div>
      <div class="vault-events"><div class="ve">${esc(nextOf(exp.list))}</div></div>
    </div>`;
}

let futureDetailType = null;
async function openFutureDetail(type) {
  futureDetailType = type;
  $('#futureDetailTitle').textContent = type === 'income' ? '未入账（远期收入）' : '待支出（远期支出）';
  $('#futureDetailMonth').value = '';
  await renderFutureDetail();
  $('#futureDetailModal').classList.remove('hidden');
}
async function renderFutureDetail() {
  const month = $('#futureDetailMonth').value;
  const url = '/api/future?type=' + futureDetailType + (month ? '&month=' + month : '');
  const data = await api(url);
  $('#futureDetailList').innerHTML = data.list.length ? data.list.map((t) => `
    <div class="va-row">
      <div class="va-main">
        <div class="va-note">${esc(t.category)}${t.note ? ' · ' + esc(t.note) : ''}${t.remark ? ' · ' + esc(t.remark) : ''}</div>
        <div class="va-at">${esc(t.date)} · ${esc(t.channel || '未分类')}</div>
      </div>
      <div class="va-amount">
        <div class="va-d-top">${t.type === 'income' ? '+' : '-'}${maskYuan(t.amount)}</div>
      </div>
      <button class="va-del" data-promote="${t.id}" title="转为已入账">⬇️</button>
    </div>`).join('') : '<div class="empty">没有远期账目</div>';
}
function closeFutureDetail() { $('#futureDetailModal').classList.add('hidden'); futureDetailType = null; }

let vaultEditId = null;
function openVaultModal(v) {
  vaultEditId = v ? v.id : null;
  $('#vaultModalTitle').textContent = v ? '编辑资金账户' : '添加资金账户';
  $('#vaultName').value = v ? v.name : '';
  $('#vaultBalance').value = v ? v.balance : '';
  $('#vaultModal').classList.remove('hidden');
}
function closeVaultModal() { $('#vaultModal').classList.add('hidden'); vaultEditId = null; }

// v0.2：金库 编辑/删除 合并弹窗
let vaultEditId2 = null;
function openVaultEditModal(v) {
  if (!v) return;
  vaultEditId2 = v.id;
  $('#vaultEditTitle').textContent = `资金账户：${v.name}`;
  $('#vaultEditName').value = v.name;
  $('#vaultEditBalance').value = v.balance;
  $('#vaultEditModal').classList.remove('hidden');
}
function closeVaultEditModal() { $('#vaultEditModal').classList.add('hidden'); vaultEditId2 = null; }

let itemEditId = null;
function openItemModal(it) {
  itemEditId = it ? it.id : null;
  $('#itemModalTitle').textContent = it ? '编辑物件' : '添加物件';
  $('#itemName').value = it ? it.name : '';
  // 编辑时金额=原始金额；新增时为空
  $('#itemAmount').value = it ? (it.original_amount ?? it.amount) : '';
  $('#itemDate').value = it ? it.purchase_date : '';
  $('#itemGainAmount').value = '';
  $('#itemGainNote').value = '';
  $('#itemInvestAmount').value = '';
  $('#itemInvestNote').value = '';
  renderItemModalEvents(it ? it.events || [] : []);
  $('#itemModal').classList.remove('hidden');
}
function renderItemModalEvents(events) {
  const gains = events.filter((e) => e.kind === 'gain');
  const invests = events.filter((e) => e.kind === 'invest');
  const renderOne = (list, sign) => list.length ? list.map((e) => `
    <div class="ie-row">
      <span class="ie-note">${esc(e.note || (sign === '-' ? '产生效益' : '额外投入'))}</span>
      <span class="ie-d">${sign}${maskYuan(Math.abs(e.delta))}</span>
      <button class="ie-del" data-ieventdel="${e.id}" title="删除">×</button>
    </div>`).join('') : '';
  $('#itemGainList').innerHTML = renderOne(gains, '-');
  $('#itemInvestList').innerHTML = renderOne(invests, '+');
}
function closeItemModal() { $('#itemModal').classList.add('hidden'); itemEditId = null; }
async function addItemEvent(kind) {
  if (!itemEditId) { toast('请先保存物件再添加事件'); return; }
  const amount = Number($(kind === 'gain' ? '#itemGainAmount' : '#itemInvestAmount').value) || 0;
  if (amount <= 0) { toast('请输入金额'); return; }
  const note = $(kind === 'gain' ? '#itemGainNote' : '#itemInvestNote').value.trim();
  try {
    await api('/api/items/' + itemEditId + '/events', { method: 'POST', body: JSON.stringify({ kind, amount, note, eventDate: new Date().toISOString().slice(0, 10) }) });
    // 清空输入
    $('#itemGainAmount').value = ''; $('#itemGainNote').value = '';
    $('#itemInvestAmount').value = ''; $('#itemInvestNote').value = '';
    await loadItems();
    const fresh = state.items.find((x) => x.id === itemEditId);
    if (fresh) renderItemModalEvents(fresh.events || []);
  } catch (err) { toast(err.message); }
}

// v0.2 第六轮：物件事件（产生效益/额外投入）已并入 itemModal，不再独立弹窗
function openVaultDetail(v) {
  if (!v) return;
  state.detailVaultId = v.id;
  $('#vaultDetailTitle').textContent = `「${v.name}」变动明细`;
  $('#vaultDetailMonth').value = '';
  renderVaultDetailList(v.events);
  $('#vaultDetailModal').classList.remove('hidden');
}
function renderVaultDetailList(events) {
  const month = $('#vaultDetailMonth').value;
  const filtered = month ? events.filter((e) => (e.at || '').slice(0, 7) === month) : events;
  $('#vaultDetailList').innerHTML = filtered.length ? filtered.map((e) => {
    // note 形如「支出 默认 / 编辑/删除回滚」，从中尝试抽出原始 transaction 的 id（保存时塞进 note）
    const txMatch = /#(\d+)/.exec(e.note || '');
    const txId = txMatch ? txMatch[1] : null;
    return `
    <div class="va-row${txId ? ' clickable' : ''}" data-txid="${txId || ''}">
      <div class="va-main">
        <div class="va-note">${esc((e.note || '').replace(/#\d+$/, '').trim() || '变动')}</div>
        <div class="va-at">${esc(e.at || '')}</div>
      </div>
      <div class="va-amount">
        <div class="va-d-top">${e.delta >= 0 ? '+' : ''}${maskYuan(e.delta)} → ${maskYuan(e.after)}</div>
      </div>
      <button class="va-del" data-eventdel="${e.id}" title="删除这条事件">🗑️</button>
    </div>`;
  }).join('') : '<div class="empty">暂无变动</div>';
}
function closeVaultDetail() { $('#vaultDetailModal').classList.add('hidden'); }

// 金库卡片：长按拖动排序（跟指针用固定增量，避免反馈循环导致乱飘）
// 通用长按拖拽排序：container 是列表/网格容器，itemSelector 是子项选择器，onOrder(ids) 保存新顺序
function makeDraggable(container, itemSelector, onOrder, opts = {}) {
  if (!container || container._drag) return;
  container._drag = true;
  const idAttr = opts.idAttr || 'data-id';
  const vertical = !!opts.vertical;
  const cards = () => [...container.querySelectorAll(itemSelector)];
  let dragging = null, timer = null, startX = 0, startY = 0;
  container.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const card = e.target.closest(itemSelector);
    if (!card) return;
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    dragging = card;
    timer = setTimeout(() => {
      card.classList.add('dragging');
      document.body.classList.add('dragging-vault');
      try { card.setPointerCapture(e.pointerId); } catch {}
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    }, 450);
  });
  container.addEventListener('pointerup', () => clearTimeout(timer));
  container.addEventListener('pointercancel', () => clearTimeout(timer));
  container.addEventListener('click', (e) => { if (container._suppressClick) { e.stopPropagation(); e.preventDefault(); container._suppressClick = false; } }, true);
  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const dx = vertical ? 0 : e.clientX - startX;
    const dy = e.clientY - startY;
    dragging.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  function onUp() {
    clearTimeout(timer);
    if (!dragging) return;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    container._suppressClick = true;
    const row = dragging;
    const others = cards().filter((r) => r !== row);
    const rect = row.getBoundingClientRect();
    const px = rect.left + rect.width / 2, py = rect.top + rect.height / 2;
    let idx = others.length, best = Infinity;
    others.forEach((r, i) => {
      const b = r.getBoundingClientRect();
      const d = vertical ? Math.abs(py - (b.top + b.height / 2)) : Math.hypot(px - (b.left + b.width / 2), py - (b.top + b.height / 2));
      if (d < best) { best = d; idx = i; }
    });
    const ids = others.map((r) => Number(r.getAttribute(idAttr)));
    ids.splice(idx, 0, Number(row.getAttribute(idAttr)));
    row.classList.remove('dragging');
    row.style.transform = '';
    document.body.classList.remove('dragging-vault');
    dragging = null;
    onOrder(ids);
  }
}
function enableVaultDrag() {
  makeDraggable($('#vaultGrid'), '.vault-card', (ids) => api('/api/vaults/order', { method: 'PUT', body: JSON.stringify({ ids }) }).then(() => loadVaults()).catch(() => {}), { idAttr: 'data-vault' });
}
// v0.2 bug修复：物件卡拖拽排序（同金库，用 data-id）
function enableItemDrag() {
  makeDraggable($('#itemGrid'), '.vault-card', (ids) => api('/api/items/order', { method: 'PUT', body: JSON.stringify({ ids }) }).then(() => loadItems()).catch(() => {}), { idAttr: 'data-id' });
}

let catMode = 'rename', catTargetId = null, catParentId = null;
function openCatModal(mode, opts = {}) {
  catMode = mode; catTargetId = opts.id || null; catParentId = opts.parent || null;
  $('#catModalTitle').textContent = mode === 'addchild' ? '添加小类' : mode === 'renamekid' ? '改小类名' : (mode === 'managekid' ? '管理小类' : '重命名大类');
  $('#catModalLabel').textContent = (mode === 'addchild' || mode === 'renamekid' || mode === 'managekid') ? '小类名称' : '大类名称';
  $('#catModalName').value = opts.name || '';
  $('#catModalColor').value = opts.color || randomColor();
  // v0.2：大类重命名时也显示删除按钮（图一框位置）
  $('#catModalDel').classList.toggle('hidden', mode !== 'rename');
  $('#catModalDel').textContent = '删除';
  // 小类不需要颜色（只有大类才显示颜色）
  $('#catColorWrap').style.display = mode === 'rename' ? '' : 'none';
  $('#catModal').classList.remove('hidden');
}
function closeCatModal() { $('#catModal').classList.add('hidden'); }

let kidsParentId = null;
function openKidsModal(parentId) {
  const p = state.categories.find((c) => c.id === parentId);
  if (!p) return;
  kidsParentId = parentId;
  $('#kidsModalTitle').textContent = `「${p.name}」的小类`;
  renderKidsList();
  enableKidsDrag();
  $('#kidsModal').classList.remove('hidden');
}
function closeKidsModal() { $('#kidsModal').classList.add('hidden'); kidsParentId = null; }
function renderKidsList() {
  const kids = state.categories.filter((k) => k.parent_id === kidsParentId);
  $('#kidsList').innerHTML = kids.map((k) => `
    <div class="kid-row" data-id="${k.id}">
      <span class="kid-name">${esc(k.name)}</span>
      <span class="kid-ops"><button title="改名" data-kidrename="${k.id}">✏️</button><button title="删除" data-kiddel2="${k.id}">🗑️</button></span>
    </div>`).join('') || '<div class="empty">暂无小类</div>';
}

// 删除小类的完整流程（带金额询问、删最后一个自动补默认）
async function deleteChild(id) {
  if (!(await requireUnlock())) return false;
  if (!(await confirmModal('删除这个小类？', '删除小类'))) return false;
  try { await api('/api/categories/' + id, { method: 'DELETE' }); return true; }
  catch (err) {
    if (/归到/.test(err.message)) {
      if (await confirmModal('该小类已有金额，是否需要归到“默认”下？', '删除小类')) {
        try { await api('/api/categories/' + id + '?move=1', { method: 'DELETE' }); return true; }
        catch (e) { toast(e.message); return false; }
      }
      return false;
    }
    toast(err.message); return false;
  }
}

// v0.2：删除大类（重命名弹窗里的删除按钮走这里）
async function deleteTopCategory(id) {
  if (!(await requireUnlock())) return false;
  if (!(await confirmModal('删除该大类及其小类？', '删除类别'))) return false;
  try { await api('/api/categories/' + id, { method: 'DELETE' }); return true; }
  catch (err) {
    if (/连同删除/.test(err.message)) {
      if (await confirmModal('该类别下已有金额，删除将连同删除这些账目，确认？', '删除类别')) {
        try { await api('/api/categories/' + id + '?force=1', { method: 'DELETE' }); return true; }
        catch (e) { toast(e.message); return false; }
      }
      return false;
    }
    toast(err.message); return false;
  }
}

// 小类列表：长按拖动排序
function enableKidsDrag() {
  makeDraggable($('#kidsList'), '.kid-row', (ids) => api('/api/categories/order', { method: 'PUT', body: JSON.stringify({ ids }) }).then(() => { renderKidsList(); loadCategories(); }).catch(() => {}), { idAttr: 'data-id', vertical: true });
}

// ---------- 类别 ----------
function renderCategories() {
  const tops = state.categories.filter((c) => !c.parent_id);
  const kids = state.categories.filter((c) => c.parent_id);
  const cell = (c) => {
    const children = kids.filter((k) => k.parent_id === c.id);
    return `<div class="cat-cell" data-id="${c.id}">
      <div class="cat-cell-head"><span class="tx-dot" style="background:${esc(c.color)}"></span><span class="cat-name" data-rename="${c.id}" title="点击重命名">${esc(c.name)}</span><span class="cat-actions"><button title="添加小类" data-addchild="${c.id}">＋</button></span></div>
      <div class="cat-cell-kids">${children.length ? children.map((k) => `<span class="kid" data-kid="${k.id}" data-kidp="${c.id}" title="点击管理小类">${esc(k.name)}</span>`).join('') : '<span class="kid muted">暂无小类</span>'}</div>
    </div>`;
  };
  const section = (kind, title) => {
    const cats = tops.filter((c) => c.kind === kind);
    return `<div class="cat-block"><div class="cat-block-label">${title}</div><div class="cat-grid">${cats.map(cell).join('') || '<span class="muted">暂无类别</span>'}</div></div>`;
  };
  $('#catList').innerHTML = section('expense', '支出类别') + section('income', '收入类别');
  enableCategoryDrag();
}

// 类别（大类）卡片：长按拖动排序（每个「支出/收入」格子里独立排序）
function enableCategoryDrag() {
  document.querySelectorAll('#catList .cat-grid').forEach((grid) => {
    makeDraggable(grid, '.cat-cell', (ids) => api('/api/categories/order', { method: 'PUT', body: JSON.stringify({ ids }) }).then(() => loadCategories()).catch(() => {}), { idAttr: 'data-id' });
  });
}

// ---------- 事件 ----------
function bindEvents() {
  $$('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $('#tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  $('#monthPicker').addEventListener('change', (e) => { state.month = e.target.value; refreshAll(); });

  // 类型切换 → 刷新类别下拉 + 必要/方式 切换
  $$('input[name="txType"]').forEach((r) => r.addEventListener('change', () => { refreshTypeCategory(); renderGrpForm(document.querySelector('input[name="txType"]:checked').value, 'tx'); }));
  // 编辑弹窗 v0.2 第五轮起已去掉「类型」「必要/方式」切换行；不再绑 editType/change
  $('#txCategory').addEventListener('change', () => fillNoteSelect('tx'));
  $('#editCategory').addEventListener('change', () => fillNoteSelect('edit'));
  $('#txNote').addEventListener('change', () => toggleNoteCustom('tx'));
  $('#editNote').addEventListener('change', () => toggleNoteCustom('edit'));
  $('#ledgerFilter').addEventListener('change', () => loadTransactions());

  // 记一笔
  $('#txForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = collectForm('tx');
    try {
      await api('/api/transactions', { method: 'POST', body: JSON.stringify(body) });
      if ($('#txAsItem').checked) {
        const cat = state.categories.find((c) => String(c.id) === String(body.categoryId));
        await api('/api/items', { method: 'POST', body: JSON.stringify({ name: body.note || (cat && cat.name) || '物件', amount: Number($('#txAmount').value) || 0, purchaseDate: body.date }) });
      }
      resetForm();
      await refreshAll();
    } catch (err) { toast(err.message); }
  });

  // 列表：整行点击 = 编辑（删除走编辑弹窗）
  $('#txList').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const rows = await api(`/api/transactions?month=${state.month}`);
      const t = rows.find((r) => String(r.id) === edit.dataset.edit);
      if (t) openEditModal(t);
    }
  });

  // 编辑弹窗
  $('#editCancel').addEventListener('click', closeEditModal);
  $('#editDel').addEventListener('click', async () => {
    if (!state.editingId) return;
    if (!(await requireUnlock())) return;
    if (!(await confirmModal('确定删除这笔账？', '删除账目'))) return;
    try {
      await api('/api/transactions/' + state.editingId, { method: 'DELETE' });
      closeEditModal(); await refreshAll();
    } catch (err) { toast(err.message); }
  });
  $('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = collectForm('edit');
    try {
      await api(`/api/transactions/${state.editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      closeEditModal();
      await refreshAll();
    } catch (err) { toast(err.message); }
  });

  // 趋势
  $('#trendToolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-unit]');
    if (b) {
      state.trend = { unit: b.dataset.unit, n: Number(b.dataset.n) };
      $$('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      loadTrend();
    }
  });
  $('#trendNum').addEventListener('change', onTrendCustom);
  $('#trendUnit').addEventListener('change', onTrendCustom);

  // 金库（弹窗）
  $('#resetUncat').addEventListener('click', async () => {
    if (!(await confirmModal('未指定交易方式的余额将清零，恢复正确的总资产。', '重置未分类资金？'))) return;
    try { await api('/api/vaults/reset-uncategorized', { method: 'PUT' }); await loadVaults(); }
    catch (err) { toast(err.message); }
  });
  $('#addVault').addEventListener('click', () => openVaultModal());
  $('#vaultGrid').addEventListener('click', async (e) => {
    // 右上角 ✏️ = 修改金额（合并删除弹窗）
    const edit = e.target.closest('[data-vaultedit]');
    if (edit) { openVaultEditModal(state.vaults.find((x) => String(x.id) === edit.dataset.vaultedit)); return; }
    // 点击卡片本体 = 查看变动明细
    const card = e.target.closest('.vault-card');
    if (card) openVaultDetail(state.vaults.find((x) => String(x.id) === card.dataset.vault));
  });
  $('#vaultDetailClose').addEventListener('click', closeVaultDetail);
  $('#vaultDetailMonth').addEventListener('change', () => {
    const fresh = state.vaults.find((x) => x.id === state.detailVaultId);
    if (fresh) renderVaultDetailList(fresh.events);
  });
  $('#vaultDetailList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-eventdel]');
    if (btn) {
      if (!(await requireUnlock())) return;
      if (!(await confirmModal('删除这条账目事件？金库余额会撤销此条变动。', '删除事件'))) return;
      await api('/api/vault-events/' + btn.dataset.eventdel, { method: 'DELETE' });
      await loadVaults();
      const fresh = state.vaults.find((x) => x.id === state.detailVaultId);
      if (fresh) renderVaultDetailList(fresh.events);
      return;
    }
    // 点行 → 跳到该笔账目的编辑弹窗
    const row = e.target.closest('[data-txid]');
    if (!row || !row.dataset.txid) return;
    const txId = row.dataset.txid;
    try {
      const all = await api('/api/transactions?month=' + (row.dataset.month || ''));
      // 找不到对应月份的，去掉月份筛再试
      let t = all.find((r) => String(r.id) === txId);
      if (!t) {
        // 再尝试全月扫一遍（行可能跨月份）
        for (let m = 1; m <= 12; m++) {
          const mm = String(m).padStart(2, '0');
          const rows = await api('/api/transactions?month=' + new Date().getFullYear() + '-' + mm);
          t = rows.find((r) => String(r.id) === txId);
          if (t) break;
        }
      }
      if (t) { closeVaultDetail(); openEditModal(t); }
      else toast('找不到这笔账');
    } catch (err) { toast(err.message); }
  });
  $('#vaultCancel').addEventListener('click', closeVaultModal);
  // 物件
  $('#addItem').addEventListener('click', () => openItemModal());
  $('#itemCancel').addEventListener('click', closeItemModal);
  $('#itemForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: $('#itemName').value, amount: Number($('#itemAmount').value) || 0, purchaseDate: $('#itemDate').value };
    try {
      if (itemEditId) await api('/api/items/' + itemEditId, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/items', { method: 'POST', body: JSON.stringify(body) });
      closeItemModal(); await loadItems();
    } catch (err) { toast(err.message); }
  });
  // v0.2 第六轮：物件弹窗内添加/删除事件
  $('#itemGainAdd').addEventListener('click', () => addItemEvent('gain'));
  $('#itemInvestAdd').addEventListener('click', () => addItemEvent('invest'));
  $('#itemModal').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ieventdel]');
    if (!btn) return;
    if (!(await requireUnlock())) return;
    if (!(await confirmModal('删除这条事件？', '删除事件'))) return;
    await api('/api/item-events/' + btn.dataset.ieventdel, { method: 'DELETE' });
    await loadItems();
    const fresh = state.items.find((x) => x.id === itemEditId);
    if (fresh) renderItemModalEvents(fresh.events || []);
  });
  $('#itemGrid').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-itemdel]');
    if (del) { if (!(await requireUnlock())) return; if (await confirmModal('删除这个物件？其事件也会一并删除。', '删除物件')) { await api('/api/items/' + del.dataset.itemdel, { method: 'DELETE' }); await loadItems(); } return; }
    // 删除单个事件
    const ievDel = e.target.closest('[data-ieventdel]');
    if (ievDel) { if (!(await requireUnlock())) return; if (!(await confirmModal('删除这条事件？物件当前价值会调整。', '删除事件'))) return; await api('/api/item-events/' + ievDel.dataset.ieventdel, { method: 'DELETE' }); await loadItems(); return; }
    // 点击物件卡片本体 → 直接编辑
    const card = e.target.closest('.item-card');
    if (card && !e.target.closest('.ie-add-btn') && !e.target.closest('.ie-del')) openItemModal(state.items.find((x) => String(x.id) === card.dataset.id));
  });
  // v0.2 第六轮：itemEventModal 已合并进 itemModal，其绑定在 itemModal 内处理（itemGainAdd/itemInvestAdd）
  $('#vaultForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: $('#vaultName').value, balance: Number($('#vaultBalance').value) || 0 };
    try {
      if (vaultEditId) await api('/api/vaults/' + vaultEditId, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/vaults', { method: 'POST', body: JSON.stringify(body) });
      closeVaultModal(); await loadVaults();
    } catch (err) { toast(err.message); }
  });

  // 类别
  $('#catForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: $('#catName').value, kind: $('#catKind').value, color: $('#catColor').value }) });
      e.target.reset(); await loadCategories();
    } catch (err) { toast(err.message); }
  });
  $('#catList').addEventListener('click', async (e) => {
    const ren = e.target.closest('[data-rename]');
    const add = e.target.closest('[data-addchild]');
    const kid = e.target.closest('[data-kid]');
    if (ren) { const c = state.categories.find((x) => String(x.id) === ren.dataset.rename); openCatModal('rename', { id: c.id, name: c.name, color: c.color }); }
    if (add) { openCatModal('addchild', { parent: Number(add.dataset.addchild) }); }
    if (kid) { openKidsModal(Number(kid.dataset.kidp)); }
  });
  $('#catRandomColor').addEventListener('click', () => { $('#catColor').value = randomColor(); });
  $('#catModalRandomColor').addEventListener('click', () => { $('#catModalColor').value = randomColor(); });
  $('#catModalCancel').addEventListener('click', closeCatModal);
  $('#catModalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#catModalName').value.trim(); if (!name) return;
    try {
      if (catMode === 'rename') await api('/api/categories/' + catTargetId, { method: 'PUT', body: JSON.stringify({ name, color: $('#catModalColor').value }) });
      else if (catMode === 'addchild') await api('/api/categories', { method: 'POST', body: JSON.stringify({ name, kind: 'expense', parent_id: catParentId }) });
      else await api('/api/categories/' + catTargetId, { method: 'PUT', body: JSON.stringify({ name }) });
      closeCatModal(); await loadCategories();
    } catch (err) { toast(err.message); }
  });
  $('#catModalDel').addEventListener('click', async () => {
    if (!catTargetId) return;
    // v0.2：大类重命名时删除走 deleteTopCategory；小类（renamekid）走 deleteChild
    const fn = catMode === 'rename' ? deleteTopCategory : deleteChild;
    if (await fn(catTargetId)) { closeCatModal(); await loadCategories(); }
  });
  $('#kidsClose').addEventListener('click', closeKidsModal);
  $('#kidsList').addEventListener('click', async (e) => {
    const ren = e.target.closest('[data-kidrename]');
    const del = e.target.closest('[data-kiddel2]');
    if (ren) {
      const k = state.categories.find((x) => String(x.id) === ren.dataset.kidrename);
      closeKidsModal();
      openCatModal('renamekid', { id: k.id, name: k.name });
    }
    if (del) {
      const id = Number(del.dataset.kiddel2);
      if (await deleteChild(id)) {
        state.categories = state.categories.filter((c) => c.id !== id);
        renderKidsList();
        loadCategories(); // 后台同步主列表
      }
    }
  });

  // 隐私
  $('#hideAmounts').addEventListener('change', async (e) => {
    const want = e.target.checked;
    if (want) { await setHide(true); }
    else { await reveal(); e.target.checked = state.settings.hideAmounts; }
  });
  $('#eyeBtn').addEventListener('click', async () => {
    if (state.settings.hideAmounts) await reveal(); else await setHide(true);
  });
  $('#lockBtn').addEventListener('click', async () => {
    if (state.locked) { if (await requireUnlock()) updateLockBtn(); }
    else { state.locked = true; updateLockBtn(); }
  });
  // 备份/导出：用带 token 的 fetch 拿文件（blob）再触发下载——避免 window.location.href 丢 token 导致 401
  $('#btnBackup').addEventListener('click', () => downloadAuthFile('/api/backup', 'finance-backup.db'));
  $('#btnExport').addEventListener('click', () => downloadAuthFile('/api/export-transactions', 'transactions.csv'));
  $('#pwdSet').addEventListener('click', () => {
    if (state.settings.hasPassword) { toast('请先清除密码再设置'); return; }
    openPwdManageModal('set');
  });
  $('#pwdClear').addEventListener('click', async () => {
    if (!state.settings.hasPassword) { toast('当前未设置密码'); return; }
    if (!(await requireUnlock())) return;
    openPwdManageModal('clear');
  });
  $('#pwdManageCancel').addEventListener('click', closePwdManageModal);
  $('#confirmCancel').addEventListener('click', () => closeConfirm(false));
  $('#confirmOk').addEventListener('click', () => closeConfirm(true));
  $('#pwdManageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const isClear = pwdManageMode === 'clear';
    if (isClear) {
      if (!state.settings.hasPassword) { toast('当前未设置密码'); closePwdManageModal(); return; }
      const ok = await api('/api/settings/verify', { method: 'POST', body: JSON.stringify({ password: $('#pwdCurrent').value }) });
      if (!ok.ok) { toast('当前密码错误'); return; }
      await api('/api/settings/password', { method: 'PUT', body: JSON.stringify({ password: '' }) });
      toast('密码已清除');
    } else {
      if (state.settings.hasPassword) { toast('请先清除密码再设置'); return; }
      const newPwd = $('#pwdNew').value.trim();
      if (!/^\d{4}$/.test(newPwd) && !/^\d{6}$/.test(newPwd)) { toast('新密码需为 4 位或 6 位数字'); return; }
      await api('/api/settings/password', { method: 'PUT', body: JSON.stringify({ password: newPwd }) });
      toast('密码已设置');
    }
    closePwdManageModal(); $('#pwdCurrent').value = ''; $('#pwdNew').value = ''; await loadSettings();
  });

  // 密码弹窗
  $('#pwdCancel').addEventListener('click', () => closePwdModal(false));
  $('#pwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/settings/verify', { method: 'POST', body: JSON.stringify({ password: $('#pwdCheck').value }) });
    if (r.ok) { state.locked = false; updateLockBtn(); closePwdModal(true); }
    else { toast('密码错误'); $('#pwdCheck').value = ''; }
  });

  // 注释小问号（ⓘ）
  document.addEventListener('mouseover', (e) => {
    const dot = e.target.closest('.info-dot');
    if (dot) showGlobalTip(dot, dot.dataset.tip);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('.info-dot')) hideGlobalTip();
  });
  // 下钻弹窗：离开分类卡片即隐藏
  const catCard = $('#catChart').closest('.card');
  if (catCard) catCard.addEventListener('mouseleave', hideDrill);

  $('#backToday').addEventListener('click', async () => {
    state.month = currentMonth(); $('#monthPicker').value = state.month; await refreshAll();
  });
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'light';
    applyTheme(cur === 'light' ? 'dark' : 'light');
  });

  enableVaultDrag();
  enableItemDrag();

  // v3 多用户：登出
  $('#logoutBtn').addEventListener('click', logout);
  // v3 阶段三：admin 切换查看用户
  $('#userSelect').addEventListener('change', onUserSwitch);
  // v3 阶段四：AI 智能记账
  $('#aiParseBtn').addEventListener('click', openAIModal);
  $('#aiParseGo').addEventListener('click', () => {
    // 识别成功后按钮变成「确认保存全部」，点它直接保存，避免反复点识别浪费额度
    if ($('#aiParseGo').dataset.mode === 'confirm') saveAIPending();
    else runAIParse();
  });
  $('#aiCancel').addEventListener('click', closeAIModal);
  // v3 阶段四：AI 消费洞察
  $('#aiInsightBtn').addEventListener('click', runAIInsight);
  // v3 阶段三：admin 额度管理（事件委托）
  $('#adminUsersList').addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-quota-add]');
    if (addBtn) { adminQuotaAdd(addBtn.dataset.uid, Number(addBtn.dataset.quotaAdd)); return; }
    const setBtn = e.target.closest('[data-quota-set]');
    if (setBtn) { adminQuotaSet(setBtn.dataset.uid, Number(setBtn.dataset.quotaSet)); return; }
  });
  // v4 模拟模式：开关切换 / 欢迎弹窗 / 拦截提示
  $('#demoEnterBtn').addEventListener('click', () => toggleDemoMode(true));
  $('#demoExitBtn').addEventListener('click', () => toggleDemoMode(false));
  $('#welcomeClose').addEventListener('click', closeWelcomeModal);
  $('#demoToastClose').addEventListener('click', closeDemoToast);

  // v0.2：远期卡片点击 = 打开明细弹窗
  $('#futureStats').addEventListener('click', (e) => {
    const card = e.target.closest('.future-card');
    if (card) openFutureDetail(card.dataset.futureType);
  });
  $('#futureDetailClose').addEventListener('click', closeFutureDetail);
  $('#futureDetailMonth').addEventListener('change', renderFutureDetail);
  $('#futureDetailList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-promote]');
    if (!btn) return;
    if (!(await requireUnlock())) return;
    if (!(await confirmModal('把这笔远期账目转为今日已入账？', '转为已入账'))) return;
    try {
      await api('/api/future/' + btn.dataset.promote + '/promote', { method: 'POST' });
      await renderFutureDetail();
      await refreshAll();
      toast('已转为今日账目');
    } catch (err) { toast(err.message); }
  });
  // v0.2：金库 编辑/删除合并弹窗
  $('#vaultEditCancel').addEventListener('click', closeVaultEditModal);
  $('#vaultEditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: $('#vaultEditName').value.trim(), balance: Number($('#vaultEditBalance').value) || 0 };
    try {
      await api('/api/vaults/' + vaultEditId2, { method: 'PUT', body: JSON.stringify(body) });
      closeVaultEditModal(); await loadVaults();
    } catch (err) { toast(err.message); }
  });
  $('#vaultEditDel').addEventListener('click', async () => {
    if (!vaultEditId2) return;
    if (!(await requireUnlock())) return;
    if (!(await confirmModal('删除这个资金账户？其变动明细也会一并删除。', '删除金库'))) return;
    try {
      await api('/api/vaults/' + vaultEditId2, { method: 'DELETE' });
      closeVaultEditModal(); await loadVaults();
    } catch (err) { toast(err.message); }
  });
}

function refreshTypeCategory() {
  const txT = document.querySelector('input[name="txType"]:checked')?.value;
  if (txT) fillCatSelect('#txCategory', txT);
  // 编辑弹窗无 editType radio（v0.2 第五轮去掉），editCategory 由 openEditModal 直接填充
}

function renderGrpForm(type, prefix) {
  const labelEl = $(`#${prefix}GrpLabel`);
  const radios = $(`#${prefix}GrpRadios`);
  if (!labelEl || !radios) return;
  if (type === 'income') {
    labelEl.innerHTML = '方式 <span class="info-dot" data-tip="title:如何区分？|content:主动收入是用时间换钱，被动收入是让钱或资产替你赚钱">ⓘ</span>';
    radios.innerHTML = '<label class="tt"><input type="radio" name="' + prefix + 'Grp" value="主动收入" /> 主动收入</label><label class="tt"><input type="radio" name="' + prefix + 'Grp" value="被动收入" checked /> 被动收入</label>';
  } else {
    labelEl.innerHTML = '必要？ <span class="info-dot" data-tip="title:如何区分是否必要？|content:同样是饮料，在很渴的时候就是必要，在嘴馋的时候就是不必要">ⓘ</span>';
    radios.innerHTML = '<label class="tt"><input type="radio" name="' + prefix + 'Grp" value="必要" /> 必要</label><label class="tt"><input type="radio" name="' + prefix + 'Grp" value="非必要" checked /> 非必要</label>';
  }
}
function fillCatSelect(sel, kind) {
  const el = $(sel); if (!el) return;
  // 只列大类（小类作为「备注」选项）
  const list = state.categories.filter((c) => c.kind === kind && !c.parent_id);
  el.innerHTML = '';
  if (!list.length) { el.innerHTML = '<option value="">请先添加类别</option>'; return; }
  list.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; el.appendChild(o); });
}

function collectForm(prefix) {
  // v0.2 第五轮：编辑表单去掉 editType/editGrp radio；type/grp 来自 state（不可改）
  const type = prefix === 'edit' ? (state.editingType || 'expense') : document.querySelector(`input[name="${prefix}Type"]:checked`).value;
  const grp = prefix === 'edit' ? (state.editingGrp || '非必要') : (document.querySelector(`input[name="${prefix}Grp"]:checked`)?.value || '非必要');
  const raw = Number($(`#${prefix}Amount`).value) || 0;
  const shareN = Number($(`#${prefix}Share`).value) || 1;
  // 分摊：金额填的是总价，写 N 人则自动算自己那份
  const amount = shareN > 1 ? Math.round(raw * 100 / shareN) / 100 : raw;
  return {
    date: $(`#${prefix}Date`).value,
    amount,
    categoryId: $(`#${prefix}Category`).value,
    note: noteVal(prefix === 'edit' ? 'edit' : 'tx'),
    remark: $(`#${prefix}Remark`).value,
    shareKind: shareN > 1 ? `÷${shareN}` : '',
    type,
    channel: $(`#${prefix}Channel`).value,
    grp,
  };
}

function openEditModal(t) {
  state.editingId = t.id;
  // v0.2 第五轮起不再切换类型 / 必要方式（这些信息来自原账目，不可改）；保留 type/grp 在 state 里供 collectForm 读取
  state.editingType = t.type;
  state.editingGrp = t.grp || '非必要';
  $('#editDate').value = t.date;
  const shareN = (t.share_kind || '').match(/÷(\d+)/)?.[1];
  const n = shareN ? Number(shareN) : 1;
  $('#editAmount').value = n > 1 ? Math.round(t.amount * n * 100) / 100 : t.amount;
  // v0.2 第七轮：小类是 select；先记住当前 note，fillNoteSelect 时恢复
  $('#editNote').dataset.cur = t.note || '';
  $('#editNoteCustom').value = t.note || '';
  $('#editRemark').value = t.remark || '';
  $('#editShare').value = n > 1 ? n : '';
  fillChannelOptions('#editChannel');
  $('#editChannel').value = t.channel || '';
  const list = state.categories.filter((c) => c.kind === t.type && !c.parent_id);
  const sel = $('#editCategory'); sel.innerHTML = '';
  list.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; sel.appendChild(o); });
  // 确保 sel.value 落到合法 option（防止某些账目 category_id 是小类 id 或已删除）
  const valid = list.find((c) => String(c.id) === String(t.category_id));
  sel.value = valid ? valid.id : (list[0] ? list[0].id : '');
  fillNoteSelect('edit');
  $('#editModal').classList.remove('hidden');
}
function closeEditModal() { $('#editModal').classList.add('hidden'); state.editingId = null; }

function fillChannelOptions(sel = '#txChannel') {
  const el = $(sel); if (!el) return;
  el.innerHTML = '';
  [['', '未分类'], ['微信', '微信'], ['支付宝', '支付宝'], ['银行卡', '银行卡'], ['现金', '现金']].forEach(([v, label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label; el.appendChild(o);
  });
}

function resetForm() {
  $('#txDate').value = new Date().toISOString().slice(0, 10);
  $('#txAmount').value = ''; $('#txNote').value = ''; $('#txRemark').value = ''; $('#txShare').value = '';
  document.querySelector('input[name="txType"][value="expense"]').checked = true;
  renderGrpForm('expense', 'tx');
  const gp = document.querySelector('input[name="txGrp"][value="非必要"]'); if (gp) gp.checked = true;
  refreshTypeCategory();
  fillNoteSelect('tx');
  $('#txNote').dataset.cur = '';
}

async function setHide(v) {
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ hideAmounts: v }) });
  await loadSettings();
  loadTrend();
  refreshAll();
}
async function reveal() {
  if (!(await requireUnlock())) return;
  await setHide(false);
}
function closePwdModal(ok = false) {
  $('#pwdModal').classList.add('hidden');
  if (unlockResolver) { const r = unlockResolver; unlockResolver = null; r(ok); }
}

let pwdManageMode = 'set';
function openPwdManageModal(mode) {
  pwdManageMode = mode;
  const isClear = mode === 'clear';
  $('#pwdManageTitle').textContent = isClear ? '清除金额密码' : '设置金额密码';
  $('#pwdNewWrap').style.display = isClear ? 'none' : '';
  $('#pwdCurrentWrap').style.display = isClear ? '' : 'none';
  $('#pwdCurrent').value = ''; $('#pwdNew').value = '';
  $('#pwdManageModal').classList.remove('hidden');
}
function closePwdManageModal() { $('#pwdManageModal').classList.add('hidden'); }

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  $('#themeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}

init();
