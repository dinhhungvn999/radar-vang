// =====================================================================
// RADAR VÀNG — bộ máy chạy 24/7 trên GitHub Actions
// Mỗi 15 phút: tải nến PAXG (≈ XAU), tính 2 loại tín hiệu đã kiểm chứng 4,5 năm:
//   [TUẦN] MACD H1 cắt + giá H1 cùng phía EMA200 + xu hướng H4 (EMA200 & MACD)   · SL 1,5×ATR H1 · ~1–2 lệnh/tuần
//   [NGÀY] RSI(2) M15 hồi sâu (<15 / >85) + giá M15 cùng phía EMA50 + xu hướng H4 · SL 1×ATR H1   · ~1 lệnh/ngày
// Lưu mọi tín hiệu vào data/signals.json, theo dõi TP1/TP2/SL và gửi Telegram.
// Không cần cài thêm thư viện (Node 20 có sẵn fetch).
// =====================================================================
import fs from 'node:fs';

const CFG = {
  RR: 2,                        // TP2 = 2R, TP1 = 1R
  LOT: +(process.env.LOT || 0.02),
  PARTIAL: +(process.env.PARTIAL || 0.01),
  BE_AFTER_TP1: true,
  // Giống EA: lãi BE_USD giá → dời SL về điểm vào, sau đó SL bám cách giá tốt nhất TRAIL_USD (áp dụng cho các loại trong BE_MODES)
  BE_USD: +(process.env.BE_USD ?? 5),
  TRAIL_USD: +(process.env.TRAIL_USD ?? 10),
  BE_MODES: (process.env.BE_MODES || 'day').split(',').map(s => s.trim()).filter(Boolean),
  RULES_V: 2,
  MAX_RISK_USD: +(process.env.MAX_RISK_USD || 80),
  START_BALANCE: +(process.env.START_BALANCE || 1000),
  SPREAD: 0.35,
  MAX_HOLD_H: 24,
  MODES: (process.env.MODES || 'week,day').split(',').map(s => s.trim()).filter(Boolean),
  LOCK_BEFORE: 30,
  WEEKLY_REPORT_DOW: 0, WEEKLY_REPORT_HOUR_VN: 9,
};
const MODE = {
  week: { tag: 'TUẦN', slm: 1.5, barSec: 3600, fresh: 3 },   // nhận tín hiệu trong 3 nến H1 gần nhất (GitHub có thể chạy trễ)
  day:  { tag: 'NGÀY', slm: 1.0, barSec: 900,  fresh: 8, rsiLo: 15, rsiHi: 85 },   // 8 nến M15 = 2 giờ
};
const STATE_FILE = 'data/signals.json';
const TG_TOKEN = process.env.TELEGRAM_TOKEN, TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const TZ = 'Asia/Ho_Chi_Minh';
const OZ = 100;

// ---------- tiện ích ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = (n, d = 2) => n == null || isNaN(n) ? '—' : (+n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = n => (n >= 0 ? '+' : '−') + '$' + fmt(Math.abs(n), 2);
const vn = ms => new Date(ms).toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'radar-vang/1.1', Accept: 'application/json' } });
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(1000 * (i + 1)); }
  }
}
const xauOpen = t => { const d = new Date(t * 1000); const w = d.getUTCDay(), h = d.getUTCHours(); return !((w === 5 && h >= 21) || w === 6 || (w === 0 && h < 23)) && h !== 21; };

// ---------- chỉ báo (giống hệt bộ kiểm chứng) ----------
const ema = (v, n) => { const k = 2 / (n + 1), o = new Array(v.length); let p; for (let i = 0; i < v.length; i++) { p = i ? v[i] * k + p * (1 - k) : v[i]; o[i] = i < n - 1 ? NaN : p; } return o; };
const rma = (v, n) => { const o = new Array(v.length).fill(NaN); let a = NaN, s = 0; for (let i = 0; i < v.length; i++) { if (i < n) { s += v[i]; if (i === n - 1) { a = s / n; o[i] = a; } } else { a = (a * (n - 1) + v[i]) / n; o[i] = a; } } return o; };
const atr = (K, n = 14) => rma(K.map((k, i) => i ? Math.max(k.h - k.l, Math.abs(k.h - K[i - 1].c), Math.abs(k.l - K[i - 1].c)) : k.h - k.l), n);
const rsi = (c, n) => { const up = [0], dn = [0]; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0)); } const u = rma(up, n), d = rma(dn, n); return u.map((x, i) => d[i] === 0 ? 100 : 100 - 100 / (1 + x / d[i])); };
function macd(c) { const f = ema(c, 12), s = ema(c, 26), m = c.map((_, i) => f[i] - s[i]); const sg = ema(m.map(x => isNaN(x) ? 0 : x), 9); return { m, s: sg.map((x, i) => i < 34 ? NaN : x) }; }
function toH4(H) { const o = []; for (const k of H) { const b = Math.floor(k.t / 14400) * 14400; const l = o[o.length - 1]; if (l && l.t === b) { l.h = Math.max(l.h, k.h); l.l = Math.min(l.l, k.l); l.c = k.c; } else o.push({ t: b, o: k.o, h: k.h, l: k.l, c: k.c }); } return o; }

// ---------- dữ liệu ----------
async function loadCandles(gran, bars) {
  const out = new Map(); let end = Math.floor(Date.now() / 1000);
  for (let p = 0; p < Math.ceil(bars / 300); p++) {
    const start = end - gran * 300;
    const d = await getJSON(`https://api.exchange.coinbase.com/products/PAXG-USD/candles?granularity=${gran}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`);
    if (!Array.isArray(d) || !d.length) break;
    for (const k of d) out.set(k[0], { t: k[0], o: +k[3], h: +k[2], l: +k[1], c: +k[4] });
    end = start; await sleep(250);
  }
  return [...out.values()].sort((a, b) => a.t - b.t).slice(-bars);
}
async function loadSpot() { try { const d = await getJSON('https://api.gold-api.com/price/XAU'); return { p: +d.price, at: Date.parse(d.updatedAt) || Date.now() }; } catch { return null; } }
const EV_VI = [[/adp/i, 'Việc làm ADP'], [/non-?farm/i, 'NFP (bảng lương phi nông nghiệp)'], [/unemployment rate/i, 'Tỷ lệ thất nghiệp'], [/cpi/i, 'CPI (lạm phát)'], [/federal funds|rate decision/i, 'Quyết định lãi suất Fed'], [/press conference/i, 'Họp báo Fed'], [/pce/i, 'PCE (lạm phát)'], [/gdp/i, 'GDP'], [/retail sales/i, 'Doanh số bán lẻ'], [/ism manufacturing/i, 'PMI sản xuất ISM'], [/ism services/i, 'PMI dịch vụ ISM'], [/ppi/i, 'PPI'], [/jolts/i, 'JOLTS'], [/claims/i, 'Đơn thất nghiệp']];
const evVi = t => (EV_VI.find(([re]) => re.test(t)) || [0, t])[1];
async function loadCalendar(state) {
  if (state.cal && Date.now() - state.cal.at < 3 * 36e5) return state.cal.items;
  try {
    const a = await getJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json', 2);
    const items = a.filter(e => e.country === 'USD' && e.impact === 'High').map(e => ({ t: Date.parse(e.date), title: e.title }));
    state.cal = { at: Date.now(), items }; return items;
  } catch (e) { console.log('Không tải được lịch:', e.message); return state.cal?.items || []; }
}

// ---------- xu hướng H4 & ATR H1 tại một thời điểm (chỉ dùng nến đã đóng) ----------
function context(H) {
  const now = Date.now() / 1000;
  const Hc = H.filter(k => k.t + 3600 <= now);
  const H4 = toH4(Hc).filter(k => k.t + 14400 <= now);
  const c4 = H4.map(k => k.c), e4 = ema(c4, 200), M4 = macd(c4);
  const i4 = new Map(); H4.forEach((k, i) => i4.set(k.t, i));
  const A = atr(Hc, 14), iH = new Map(); Hc.forEach((k, i) => iH.set(k.t, i));
  const st4At = t => { const j = i4.get(Math.floor(t / 14400) * 14400 - 14400); if (j == null) return 0; return (c4[j] > e4[j] && M4.m[j] > M4.s[j]) ? 1 : (c4[j] < e4[j] && M4.m[j] < M4.s[j]) ? -1 : 0; };
  const atrAt = t => { const j = iH.get(Math.floor(t / 3600) * 3600 - 3600); return j == null ? NaN : A[j]; };
  return { Hc, H4, st4At, atrAt, st4Now: (() => { const j = H4.length - 1; return (c4[j] > e4[j] && M4.m[j] > M4.s[j]) ? 1 : (c4[j] < e4[j] && M4.m[j] < M4.s[j]) ? -1 : 0; })() };
}

// ---------- [TUẦN] MACD H1 + EMA200 H1 + xu hướng H4 ----------
function detectWeek(ctx) {
  const H = ctx.Hc, c = H.map(k => k.c), e200 = ema(c, 200), M = macd(c), A = atr(H, 14);
  const n = H.length - 1, found = [];
  for (let i = n; i > n - MODE.week.fresh && i > 0; i--) {
    const x = M.m[i] > M.s[i] && M.m[i - 1] <= M.s[i - 1] ? 1 : M.m[i] < M.s[i] && M.m[i - 1] >= M.s[i - 1] ? -1 : 0;
    if (!x || !xauOpen(H[i].t) || (c[i] > e200[i] ? 1 : -1) !== x) continue;
    if (ctx.st4At(H[i].t + 3600) !== x) continue;
    found.push({ mode: 'week', dir: x, barT: H[i].t, entryT: H[i].t + 3600, entry: c[i], atr: A[i] });
  }
  return found;
}
// ---------- [NGÀY] RSI(2) M15 hồi sâu theo xu hướng H4 ----------
function detectDay(ctx, M15) {
  const now = Date.now() / 1000;
  const M = M15.filter(k => k.t + 900 <= now), c = M.map(k => k.c), r2 = rsi(c, 2), e50 = ema(c, 50);
  const n = M.length - 1, found = [];
  for (let i = n; i > n - MODE.day.fresh && i > 60; i--) {
    if (!xauOpen(M[i].t)) continue;
    const st = ctx.st4At(M[i].t);
    const x = st > 0 && r2[i] < MODE.day.rsiLo && c[i] > e50[i] ? 1 : st < 0 && r2[i] > MODE.day.rsiHi && c[i] < e50[i] ? -1 : 0;
    if (!x) continue;
    const a = ctx.atrAt(M[i].t); if (!(a > 0)) continue;
    found.push({ mode: 'day', dir: x, barT: M[i].t, entryT: M[i].t + 900, entry: c[i], atr: a, rsi2: +r2[i].toFixed(1) });
  }
  return found;
}

// ---------- theo dõi lệnh: 0.02 lot, TP1 chốt 0.01, dời SL về điểm vào, TP2 phần còn lại, tối đa 24h ----------
function track(sig, bars, events) {
  if (sig.status === 'closed') return;
  const bs = MODE[sig.mode].barSec, now = Date.now() / 1000;
  const list = bars.filter(k => k.t >= sig.entryT && k.t < sig.entryT + CFG.MAX_HOLD_H * 3600);
  const d = sig.dir, rem = +(sig.lot - sig.partial).toFixed(2);
  const pnl = (price, lots) => (price - sig.entry) * d * lots * OZ;
  const beOn = CFG.BE_MODES.includes(sig.mode) && CFG.BE_USD > 0;
  let tp1 = false, out = null, exitP = null, exitT = null, tp1T = null, v = 0, lots = sig.lot;
  let sl = sig.sl, best = sig.entry, moved = false, movedT = null;
  // Đi theo đường giá trong từng nến (mở → đáy/đỉnh → đóng), giống cách EA xử lý từng tick
  outer: for (const k of list) {
    const closed = k.t + bs <= now;
    const path = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    for (let q = 1; q < 4; q++) {
      const a = path[q - 1], b = path[q]; if (a === b) continue;
      if ((b - a) * d < 0) {                       // giá đi ngược → kiểm tra SL (gốc, hoà vốn hoặc trailing)
        if ((b - sl) * d <= 0) {
          exitP = (a - sl) * d <= 0 ? a : sl; exitT = k.t; v += pnl(exitP, lots);
          out = (exitP - sig.entry) * d < -0.01 ? 'sl' : (exitP - sig.entry) * d > 0.5 ? 'trail' : 'be';
          break outer;
        }
      } else {                                       // giá đi thuận → TP1, TP2, dời SL
        if (!tp1 && (b - sig.tp1) * d >= 0) {
          tp1 = true; tp1T = k.t; v += pnl(sig.tp1, sig.partial); lots = rem;
          if (CFG.BE_AFTER_TP1 && (sl - sig.entry) * d < 0) sl = sig.entry;
        }
        if ((b - sig.tp2) * d >= 0) { out = 'tp2'; exitP = sig.tp2; exitT = k.t; v += pnl(sig.tp2, lots); break outer; }
        best = d > 0 ? Math.max(best, b) : Math.min(best, b);
        if (beOn) {
          if (!moved && (best - sig.entry) * d >= CFG.BE_USD) { if ((sl - sig.entry) * d < 0) sl = sig.entry; moved = true; movedT = k.t; }
          if (moved && CFG.TRAIL_USD > 0) { const ts = best - d * CFG.TRAIL_USD; if ((ts - sl) * d > 0) sl = ts; }
        }
      }
    }
    if (!closed) break;
  }
  if (!out && now >= sig.entryT + CFG.MAX_HOLD_H * 3600 && list.length) {
    const last = list[list.length - 1]; out = 'time'; exitP = last.c; exitT = last.t; v += pnl(exitP, lots);
  }
  sig.slNow = +sl.toFixed(2); sig.rulesV = CFG.RULES_V;
  if (moved && !sig.beMoved) { sig.beMoved = true; sig.beAt = (movedT + bs) * 1000; if (!out) events.push({ type: 'bemove', sig }); }
  if (tp1 && !sig.tp1Hit) { sig.tp1Hit = true; sig.tp1At = (tp1T + bs) * 1000; events.push({ type: 'tp1', sig }); }
  if (out) {
    sig.status = 'closed'; sig.outcome = out; sig.exitPrice = exitP; sig.exitAt = Math.min(Date.now(), (exitT + bs) * 1000);
    // hoà vốn thuần (chưa TP1) coi như 0$, giống EA: SL đặt đúng giá vào nên không mất spread thêm
    sig.usd = +(out === 'be' && !tp1 ? 0 : v - CFG.SPREAD * sig.lot * OZ).toFixed(2); sig.R = +(sig.usd / sig.riskUSD).toFixed(2);
    events.push({ type: 'close', sig });
  } else if (tp1) sig.status = 'tp1';
}

// ---------- thống kê ----------
function stats(signals, mode) {
  const list = signals.filter(s => s.status === 'closed' && !s.skipped && (!mode || s.mode === mode));
  const n = list.length, win = list.filter(s => s.usd > 0).length, loss = list.filter(s => s.usd < 0).length, by = o => list.filter(s => s.outcome === o).length;
  let peak = 0, cum = 0, dd = 0, streak = 0, maxStreak = 0;
  for (const s of list) { cum += s.usd; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); if (s.usd < 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  return { n, win, loss, flat: n - win - loss, tp2: by('tp2'), be: by('be'), trail: by('trail'), sl: by('sl'), time: by('time'), winRate: n ? win / n * 100 : 0, usd: +cum.toFixed(2), dd: +dd.toFixed(2), maxStreak, balance: +(CFG.START_BALANCE + cum).toFixed(2) };
}

// ---------- Telegram ----------
async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('--- (chưa cấu hình Telegram) ---\n' + text.replace(/<[^>]+>/g, '')); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
  if (!r.ok) console.log('Telegram lỗi:', r.status, await r.text());
}
const px = (s, p) => fmt(p + (s.basis || 0));
const tagOf = s => `[${MODE[s.mode].tag}]`;
function msgNew(s, cal, spot) {
  const side = s.dir > 0 ? '🟢 <b>MUA</b>' : '🔴 <b>BÁN</b>', rem = +(s.lot - s.partial).toFixed(2);
  const lockEv = cal.find(e => e.t >= s.entryT * 1000 - CFG.LOCK_BEFORE * 6e4 && e.t <= s.entryT * 1000 + 3 * 36e5);
  const why = s.mode === 'week'
    ? `✓ H4 ${s.dir > 0 ? 'tăng' : 'giảm'} (giá ${s.dir > 0 ? 'trên' : 'dưới'} EMA200 + MACD cùng chiều)\n✓ H1 ${s.dir > 0 ? 'trên' : 'dưới'} EMA200, MACD vừa cắt ${s.dir > 0 ? 'lên' : 'xuống'}`
    : `✓ H4 ${s.dir > 0 ? 'tăng' : 'giảm'} (giá ${s.dir > 0 ? 'trên' : 'dưới'} EMA200 + MACD cùng chiều)\n✓ M15 ${s.dir > 0 ? 'hồi sâu' : 'hồi mạnh lên'}: RSI(2) = ${s.rsi2}, giá vẫn ${s.dir > 0 ? 'trên' : 'dưới'} EMA50`;
  let m = `${side} XAU/USD ${tagOf(s)} — Radar Vàng #${s.no}\n⏱ Nến ${s.mode === 'week' ? 'H1' : 'M15'} đóng ${vn(s.entryT * 1000)} (giờ VN)\n\n` +
    `📍 Vào: <b>${px(s, s.entry)}</b>${spot ? ` (giá hiện tại ~${fmt(spot.p)})` : ''}\n` +
    `🛑 SL: <b>${px(s, s.sl)}</b>  →  ${usd(-s.riskUSD)} (${s.lot} lot)\n` +
    `🎯 TP1: <b>${px(s, s.tp1)}</b>  →  chốt ${s.partial} lot ${usd(s.riskUSD * s.partial / s.lot)}, dời SL về điểm vào\n` +
    `🏁 TP2: <b>${px(s, s.tp2)}</b>  →  ${rem} lot còn lại ${usd(2 * s.riskUSD * rem / s.lot)}\n` +
    (CFG.BE_MODES.includes(s.mode) && CFG.BE_USD > 0 ? `🛡 Lãi ${fmt(CFG.BE_USD)} giá → dời SL về điểm vào, sau đó SL bám cách giá ${fmt(CFG.TRAIL_USD)}\n` : '') +
    `⌛ Hết hạn: ${vn((s.entryT + CFG.MAX_HOLD_H * 3600) * 1000)}\n\n${why}\n`;
  if (s.skipped) m += `\n⚠️ <b>Rủi ro ${usd(-s.riskUSD)} vượt giới hạn $${CFG.MAX_RISK_USD}</b> — khuyên BỎ QUA (radar vẫn theo dõi để thống kê).`;
  if (lockEv) m += `\n⚠️ Tin mạnh <b>${evVi(lockEv.title)}</b> lúc ${vn(lockEv.t)} — cân nhắc chờ sau tin hoặc giảm khối lượng.`;
  if (s.lateMin > 20) {
    const moved = spot ? (spot.p - (s.entry + (s.basis || 0))) * s.dir : null;
    m += `\nℹ️ Phát hiện trễ ${s.lateMin} phút` + (moved != null ? ` — giá đã đi ${moved >= 0 ? 'thuận' : 'ngược'} ${fmt(Math.abs(moved))}$ so với điểm vào.` : '.');
    if (moved != null && moved > 0.5 * s.atr) m += ` Giá đã chạy xa: chỉ vào nếu giá hồi lại gần <b>${px(s, s.entry)}</b>, hoặc bỏ qua.`;
  }
  return m + `\n\n<i>Công cụ hỗ trợ, không phải lời khuyên đầu tư.</i>`;
}
function msgEvent(ev, all) {
  const s = ev.sig, st = stats(all), sm = stats(all, s.mode);
  if (ev.type === 'bemove') return `🛡 <b>#${s.no} ${tagOf(s)} đã lãi ${fmt(CFG.BE_USD)} giá</b> — dời SL về điểm vào <b>${px(s, s.entry)}</b>, lệnh không còn rủi ro. Sau đó SL bám cách giá ${fmt(CFG.TRAIL_USD)}.`;
  if (ev.type === 'tp1') return `🎯 <b>#${s.no} ${tagOf(s)} chạm TP1</b> ${px(s, s.tp1)}\nChốt ${s.partial} lot: ${usd(s.riskUSD * s.partial / s.lot)}\n👉 Dời SL phần còn lại về điểm vào <b>${px(s, s.entry)}</b>, chờ TP2 ${px(s, s.tp2)}.`;
  const icon = { tp2: '🏆', be: '🤝', trail: '🔒', sl: '❌', time: '⌛' }[s.outcome];
  const name = { tp2: 'CHẠM TP2', be: s.tp1Hit ? 'HOÀ VỐN phần còn lại (đã lời TP1)' : 'HOÀ VỐN (SL đã dời về điểm vào)', trail: 'CHỐT LÃI bằng SL bám giá', sl: 'CHẠM CẮT LỖ', time: 'HẾT 24 GIỜ, đóng theo giá' }[s.outcome];
  return `${ev.corrected ? '✏️ <i>Tính lại theo quy tắc mới (dời SL về điểm vào khi lãi ' + fmt(CFG.BE_USD) + ' giá)</i>\n' : ''}${icon} <b>#${s.no} ${tagOf(s)} ${s.dir > 0 ? 'MUA' : 'BÁN'} — ${name}</b>\nĐóng ở ${px(s, s.exitPrice)} · Kết quả: <b>${usd(s.usd)}</b> (${s.R >= 0 ? '+' : ''}${s.R}R)${s.skipped ? ' · <i>lệnh khuyên bỏ qua, không tính vào tài khoản</i>' : ''}\n\n` +
    `📊 ${tagOf(s)}: ${sm.n} lệnh · thắng ${sm.win} · thua ${sm.loss} · hoà ${sm.flat} (${fmt(sm.winRate, 0)}% thắng) · ${usd(sm.usd)}\n💰 Tài khoản demo (cả 2 loại): <b>$${fmt(st.balance)}</b> (${usd(st.usd)})`;
}
function msgWeekly(all) {
  const weekAgo = Date.now() - 7 * 864e5, st = stats(all);
  let m = `📅 <b>Tổng kết tuần — Radar Vàng</b>\n`;
  for (const md of CFG.MODES) {
    const wk = all.filter(s => s.mode === md && s.status === 'closed' && s.exitAt >= weekAgo && !s.skipped), w = wk.reduce((a, s) => a + s.usd, 0), sm = stats(all, md);
    m += `\n<b>[${MODE[md].tag}]</b> tuần qua: ${wk.length} lệnh · ${wk.filter(s => s.usd > 0).length} thắng · ${wk.filter(s => s.usd < 0).length} thua · <b>${usd(w)}</b>\n` +
      `   Từ đầu: ${sm.n} lệnh · ${fmt(sm.winRate, 0)}% thắng · TP2 ${sm.tp2} · TP1+hoà ${sm.be} · SL ${sm.sl} · hết giờ ${sm.time} · ${usd(sm.usd)}\n`;
  }
  const open = all.filter(s => s.status !== 'closed');
  m += `\n💰 Tài khoản demo: <b>$${fmt(st.balance)}</b> (${usd(st.usd)}) · sụt giảm lớn nhất $${fmt(st.dd)} · chuỗi thua dài nhất ${st.maxStreak}` +
    (open.length ? `\n⏳ Đang mở: ${open.map(s => `#${s.no} ${tagOf(s)} ${s.dir > 0 ? 'MUA' : 'BÁN'}${s.tp1Hit ? ' (đã TP1)' : ''}`).join(', ')}` : '') +
    `\n\nKỳ vọng theo kiểm chứng: TUẦN ~55%, NGÀY ~54% lệnh có lãi; có lúc thua 6–8 lệnh liên tiếp — một tuần chưa nói lên nhiều.`;
  return m;
}

// ---------- chạy ----------
async function main() {
  fs.mkdirSync('data', { recursive: true });
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { version: 2, signals: [], startedAt: Date.now() };
  state.signals.forEach(s => { s.mode ||= 'week'; s.lot ??= CFG.LOT; s.partial ??= CFG.PARTIAL; });
  state.config = { modes: CFG.MODES, beUSD: CFG.BE_USD, trailUSD: CFG.TRAIL_USD, beModes: CFG.BE_MODES, lot: CFG.LOT, partial: CFG.PARTIAL, maxRiskUSD: CFG.MAX_RISK_USD, startBalance: CFG.START_BALANCE, rr: CFG.RR, maxHoldH: CFG.MAX_HOLD_H, week: { slAtrH1: MODE.week.slm }, day: { slAtrH1: MODE.day.slm, rsiLo: MODE.day.rsiLo, rsiHi: MODE.day.rsiHi } };
  const before = JSON.stringify(state.signals);
  const [H, M15, spot] = await Promise.all([loadCandles(3600, 2400), loadCandles(900, 600), loadSpot()]);
  if (H.length < 1200 || M15.length < 200) throw new Error(`Thiếu dữ liệu nến: H1=${H.length} M15=${M15.length}`);
  const cal = await loadCalendar(state);
  const basis = spot && Date.now() - spot.at < 6 * 36e5 && xauOpen(Date.now() / 1000) ? +(spot.p - M15[M15.length - 1].c).toFixed(2) : 0;
  const ctx = context(H);

  // 1) cập nhật lệnh đang mở
  const events = [];
  // Lệnh cũ bị ghi "chạm SL" theo quy tắc trước: nếu còn đủ dữ liệu nến thì tính lại theo quy tắc dời SL mới
  for (const s of state.signals) {
    if ((s.rulesV || 1) >= CFG.RULES_V || !CFG.BE_MODES.includes(s.mode)) continue;
    const bars = s.mode === 'day' ? M15 : H;
    if (s.status === 'closed' && s.outcome === 'sl' && bars.length && bars[0].t <= s.entryT) {
      const old = { ...s };
      delete s.outcome; delete s.exitPrice; delete s.exitAt; delete s.usd; delete s.R; s.status = s.tp1Hit ? 'tp1' : 'open';
      const tmp = []; track(s, bars, tmp);
      if (s.status === 'closed' && s.outcome !== 'sl') { const ev = tmp.find(e => e.type === 'close'); if (ev) { ev.corrected = true; events.push(ev); } console.log('Tính lại lệnh', s.id, old.outcome, '→', s.outcome); }
      else if (s.status !== 'closed') Object.assign(s, old);   // an toàn: giữ nguyên nếu không tính lại được
    }
    s.rulesV = CFG.RULES_V;
  }
  for (const s of state.signals) track(s, s.mode === 'day' ? M15 : H, events);

  for (const ev of events) await tg(msgEvent(ev, state.signals));
  events.sent = events.length;

  // 2) tín hiệu mới (mỗi loại chỉ 1 lệnh mở tại một thời điểm — đúng như kiểm chứng)
  let dirty = false;
  const found = [...(CFG.MODES.includes('week') ? detectWeek(ctx) : []), ...(CFG.MODES.includes('day') ? detectDay(ctx, M15) : [])].sort((a, b) => a.barT - b.barT);
  for (const f of found) {
    const id = `${f.mode}_${f.barT}_${f.dir}`;
    if (state.signals.some(s => s.id === id)) continue;
    const blocker = state.signals.find(s => s.mode === f.mode && (s.status !== 'closed' || (s.exitAt || 0) > f.entryT * 1000));
    if (blocker) {
      console.log('Đang có lệnh mở cùng loại, bỏ qua:', id);
      state.skippedIds = state.skippedIds || [];
      // chỉ báo 1 lần cho mỗi lệnh đang mở (tránh nhắn lặp), và chỉ khi tín hiệu mới cách lệnh đó ≥ 1 giờ
      if (!state.skippedIds.includes(blocker.id) && f.barT >= blocker.entryT + 3600) {
        state.skippedIds.push(blocker.id); state.skippedIds = state.skippedIds.slice(-200); dirty = true;
        await tg(`⏸ <b>${f.dir > 0 ? 'MUA' : 'BÁN'} XAU/USD [${MODE[f.mode].tag}] — tín hiệu mới bị BỎ QUA</b>\nNến ${f.mode === 'week' ? 'H1' : 'M15'} đóng ${vn(f.entryT * 1000)} · giá ${fmt(f.entry + basis)}\nLý do: lệnh #${blocker.no} ${tagOf(blocker)} ${blocker.dir > 0 ? 'MUA' : 'BÁN'} (vào ${px(blocker, blocker.entry)}) vẫn đang mở — mỗi loại chỉ giữ 1 lệnh, đúng như khi kiểm chứng. (Chỉ báo 1 lần cho lệnh này.)`);
      }
      continue;
    }
    const r = f.atr * MODE[f.mode].slm, riskUSD = +(r * CFG.LOT * OZ).toFixed(2);
    const s = {
      id, no: (state.signals.at(-1)?.no || 0) + 1, mode: f.mode, dir: f.dir, barT: f.barT, entryT: f.entryT, createdAt: Date.now(),
      lateMin: Math.round((Date.now() / 1000 - f.entryT) / 60), entry: f.entry, sl: f.entry - f.dir * r, tp1: f.entry + f.dir * r, tp2: f.entry + f.dir * r * CFG.RR,
      atr: f.atr, rsi2: f.rsi2, riskUSD, basis, lot: CFG.LOT, partial: CFG.PARTIAL, skipped: riskUSD > CFG.MAX_RISK_USD, status: 'open'
    };
    state.signals.push(s); track(s, f.mode === 'day' ? M15 : H, events);
    await tg(msgNew(s, cal, spot));
  }

  // 3) TP1 / đóng lệnh
  for (const ev of events.slice(events.sent || 0)) await tg(msgEvent(ev, state.signals));

  // 4) tổng kết tuần (Chủ nhật 9:00 giờ VN)
  const vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  if (vnNow.getDay() === CFG.WEEKLY_REPORT_DOW && vnNow.getHours() >= CFG.WEEKLY_REPORT_HOUR_VN && Date.now() - (state.lastWeekly || 0) > 5 * 864e5) {
    await tg(msgWeekly(state.signals)); state.lastWeekly = Date.now(); dirty = true;
  }
  // 5) lần chạy đầu
  if (!state.welcomed) {
    const last = ctx.Hc[ctx.Hc.length - 1];
    await tg(`✅ <b>Radar Vàng đã chạy 24/7</b>\nKiểm tra mỗi 15 phút · 2 loại tín hiệu:\n• [TUẦN] MACD H1 + EMA200 + xu hướng H4 (~1–2 lệnh/tuần)\n• [NGÀY] RSI(2) M15 hồi sâu theo xu hướng H4 (~1 lệnh/ngày)\n${CFG.LOT} lot, chốt ${CFG.PARTIAL} ở TP1, dời SL về điểm vào · bỏ qua lệnh rủi ro > $${CFG.MAX_RISK_USD}\n\nHiện tại: giá ${fmt(last.c + basis)}, xu hướng H4 ${ctx.st4Now > 0 ? 'TĂNG (chỉ tìm MUA)' : ctx.st4Now < 0 ? 'GIẢM (chỉ tìm BÁN)' : 'chưa rõ (đứng ngoài)'}. Tổng kết gửi mỗi Chủ nhật 9:00.`);
    state.welcomed = true; dirty = true;
  }

  state.stats = stats(state.signals); state.statsWeek = stats(state.signals, 'week'); state.statsDay = stats(state.signals, 'day');
  const lh = ctx.Hc[ctx.Hc.length - 1];
  state.last = { t: lh.t, price: +(M15[M15.length - 1].c + basis).toFixed(2), st4: ctx.st4Now };
  const changed = dirty || JSON.stringify(state.signals) !== before || events.length || state.aliveDay !== new Date().toISOString().slice(0, 10);
  state.aliveDay = new Date().toISOString().slice(0, 10);
  state.updatedAt = Date.now();
  if (changed) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`OK · H1 ${H.length} · M15 ${M15.length} · tín hiệu ${found.length} · sự kiện ${events.length} · ghi file: ${!!changed}`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
