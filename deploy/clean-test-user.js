const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/finance.db');
const name = process.argv[2];
const u = db.prepare('SELECT id, username FROM users WHERE username=?').get(name);
if (!u) { console.log('not found: ' + name); process.exit(0); }
for (const t of ['categories', 'transactions', 'vaults', 'vault_events', 'items', 'item_events', 'sessions']) {
  db.prepare('DELETE FROM ' + t + ' WHERE user_id=?').run(u.id);
}
db.prepare('DELETE FROM settings WHERE user_id=?').run(u.id);
db.prepare('DELETE FROM users WHERE id=?').run(u.id);
console.log('cleaned: ' + name + ' (id=' + u.id + ')');
const left = db.prepare('SELECT username FROM users ORDER BY id').all();
console.log('remaining users: ' + left.map(function (x) { return x.username; }).join(', '));
