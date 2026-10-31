const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const db = new Database('otc.db');

app.use(express.json());
app.use(express.static(__dirname));

// ─── База ───
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    balance REAL DEFAULT 0,
    cashback_earned REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL,
    payout REAL,
    liability REAL,
    rule_type TEXT,
    win_probability REAL,
    status TEXT DEFAULT 'open',
    result TEXT,
    cashback REAL DEFAULT 0,
    cashback_rate REAL DEFAULT 0,
    platform_share REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    settled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS platform (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    reserve REAL DEFAULT 10000,
    profit REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS risk_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reserve REAL,
    liability REAL,
    net_reserve REAL,
    state TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO platform (id, reserve, profit) VALUES (1, 10000, 0);
`);

// ─── Қоидаҳо ───
const RULES = {
  SMALL: { maxAmount: 10, payout: 0.40, winProbability: 0.70 },
  LARGE: { minAmount: 15, payout: 0.92, winProbability: 0.30 }
};

function getRule(amount) {
  if (amount <= RULES.SMALL.maxAmount) return { type: 'SMALL', ...RULES.SMALL };
  return { type: 'LARGE', ...RULES.LARGE };
}

// ─── Risk ───
function getLiability() {
  const r = db.prepare("SELECT COALESCE(SUM(liability),0) AS t FROM trades WHERE status='open'").get();
  return r.t;
}

function getReserveState() {
  const p = db.prepare('SELECT reserve, profit FROM platform WHERE id=1').get();
  const L = getLiability();
  const R = p.reserve;
  const N = R - L;
  let state, cashbackRate, maxStake;
  if (N >= 10000)      { state='GOOD';      cashbackRate=0.30; maxStake=500; }
  else if (N >= 5000)  { state='CAUTION';   cashbackRate=0.20; maxStake=200; }
  else if (N >= 2000)  { state='RISK';      cashbackRate=0.10; maxStake=100; }
  else if (N >= 1000)  { state='HIGH_RISK'; cashbackRate=0.00; maxStake=50; }
  else                 { state='BAD';       cashbackRate=0.00; maxStake=0; }
  return { R, L, N, state, cashbackRate, maxStake };
}

function canPlaceTrade(amount, payout) {
  const s = getReserveState();
  if (s.state === 'BAD' || s.maxStake === 0)
    return { ok: false, reason: 'Савдоҳои нав қатъ шудаанд (захира хеле кам)' };
  if (amount > s.maxStake)
    return { ok: false, reason: `Ҳадди максималӣ дар ҳолати ${s.state}: ${s.maxStake} сомонӣ` };
  const newN = s.R - (s.L + amount * (1 + payout));
  if (newN < 1000)
    return { ok: false, reason: 'Савдо рад шуд: захира кофӣ нест' };
  return { ok: true };
}

function logRisk() {
  const s = getReserveState();
  db.prepare('INSERT INTO risk_log (reserve, liability, net_reserve, state) VALUES (?,?,?,?)')
    .run(s.R, s.L, s.N, s.state);
  return s;
}

// ─── Савдо ───
function placeTrade(userId, amount) {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!user) return { ok: false, reason: 'Корбар ёфт нашуд' };
  if (user.balance < amount) return { ok: false, reason: 'Баланс кофӣ нест' };
  if (amount <= 0) return { ok: false, reason: 'Маблағи нодуруст' };

  const rule = getRule(amount);
  const check = canPlaceTrade(amount, rule.payout);
  if (!check.ok) return check;

  const liability = amount * (1 + rule.payout);
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, userId);

  const info = db.prepare(`
    INSERT INTO trades (user_id, amount, payout, liability, rule_type, win_probability, status)
    VALUES (?, ?, ?, ?, ?, ?, 'open')
  `).run(userId, amount, rule.payout, liability, rule.type, rule.winProbability);

  logRisk();
  return { ok: true, tradeId: info.lastInsertRowid, amount, payout: rule.payout, ruleType: rule.type };
}

function settleTrade(tradeId) {
  const trade = db.prepare('SELECT * FROM trades WHERE id=?').get(tradeId);
  if (!trade) return { ok: false, reason: 'Савдо ёфт нашуд' };
  if (trade.status !== 'open') return { ok: false, reason: 'Савдо аллакай анҷом ёфтааст' };

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(trade.user_id);
  const platform = db.prepare('SELECT * FROM platform WHERE id=1').get();
  const state = getReserveState();
  const rule = getRule(trade.amount);

  const result = Math.random() < rule.winProbability ? 'won' : 'lost';
  let cashback = 0, platformShare = 0;
  let newReserve = platform.reserve, newProfit = platform.profit;

  if (result === 'lost') {
    const rate = state.cashbackRate;
    cashback = trade.amount * rate;
    platformShare = trade.amount - cashback;
    db.prepare('UPDATE users SET balance = balance + ?, cashback_earned = cashback_earned + ? WHERE id=?')
      .run(cashback, cashback, user.id);
    newReserve = platform.reserve - cashback;
    newProfit = platform.profit + platformShare;
  } else {
    const payoutAmount = trade.amount * trade.payout;
    const totalReturn = trade.amount + payoutAmount;
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(totalReturn, user.id);
    newReserve = platform.reserve - payoutAmount;
    newProfit = platform.profit - payoutAmount;
  }

  db.prepare('UPDATE platform SET reserve = ?, profit = ? WHERE id=1').run(newReserve, newProfit);

  db.prepare(`UPDATE trades SET status=?, result=?, cashback=?, cashback_rate=?,
    platform_share=?, settled_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(result, result, cashback, state.cashbackRate, platformShare, tradeId);

  logRisk();
  return {
    ok: true, tradeId, result, cashback, platformShare,
    newBalance: db.prepare('SELECT balance FROM users WHERE id=?').get(user.id).balance,
    reserve: newReserve, profit: newProfit
  };
}

// ─── API ───
app.post('/api/user', (req, res) => {
  const { name, balance } = req.body;
  if (!name) return res.json({ ok
