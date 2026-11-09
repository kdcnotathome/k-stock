'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(__dirname, 'public');
const OFFICIAL = {
  twse: 'https://openapi.twse.com.tw/v1',
  tpex: 'https://www.tpex.org.tw/openapi/v1',
  twseHistory: 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY'
};
const cache = new Map();
const CACHE_MS = 5 * 60_000;
const EXTRA_MS = 30 * 60_000;
const lastGood = new Map();
const counts = new Map();
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options':'nosniff' });
  res.end(JSON.stringify(body));
}
function pick(row, ...keys) {
  if (!row || typeof row !== 'object') return null;
  const own = Object.keys(row);
  for (const name of keys) {
    const k = own.find(k => k.toLowerCase() === name.toLowerCase());
    if (k && row[k] !== null && row[k] !== undefined && String(row[k]).trim() !== '') return row[k];
  }
  return null;
}
function num(value) {
  if (value == null) return null;
  const text = String(value).trim().replace(/[,\s]/g, '').replace(/[＋+▲△]/g, '+').replace(/[－−▼▽]/g, '-');
  if (!text || text === '--' || text === '---' || text === 'X' || text === '除權息' || text === 'N/A') return null;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
function isoDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^\d{7}$/.test(s)) return `${String(Number(s.slice(0,3)) + 1911)}-${s.slice(3,5)}-${s.slice(5,7)}`;
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6)}`;
  if (/^\d{2,3}\/\d{1,2}\/\d{1,2}$/.test(s)) {
    const [y,m,d] = s.split('/').map(Number); return `${String(y + (y < 1911 ? 1911 : 0))}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}
function normalize(r, market) {
  const code = String(pick(r, 'Code','SecuritiesCompanyCode','StockCode','股票代號','證券代號') || '').trim();
  const name = String(pick(r, 'Name','CompanyName','SecuritiesCompanyName','股票名稱','證券名稱') || '').trim();
  if (!/^[0-9A-Za-z]{4,7}$/.test(code) || !name) return null;
  const close = num(pick(r,'ClosingPrice','Close','收盤價','收盤'));
  const change = num(pick(r,'Change','漲跌','漲跌價差'));
  const prior = close != null && change != null ? close - change : null;
  return {
    code, name, market,
    date: isoDate(pick(r,'Date','日期','TradeDate')),
    open: num(pick(r,'OpeningPrice','Open','開盤價')),
    high: num(pick(r,'HighestPrice','High','最高價')),
    low: num(pick(r,'LowestPrice','Low','最低價')),
    close, change, changePct: prior != null && prior > 0 ? Number((100*change/prior).toFixed(3)) : null,
    volume: num(pick(r,'TradeVolume','TradingShares','TradeShares','成交股數')),
    amount: num(pick(r,'TradeValue','TradingValue','成交金額')),
    trades: num(pick(r,'Transaction','TransactionCount','交易筆數'))
  };
}
async function fetchJson(url, ttl=CACHE_MS) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < ttl) return { data: cached.data, stale: false };
  // Merge concurrent queries to protect the official endpoint.
  if (cached?.promise) return cached.promise;
  const promise = (async () => {
    const res = await fetch(url, {
      headers: { Accept:'application/json', 'User-Agent':'Mozilla/5.0 (compatible; KStockResearch; contact: individual research website)' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw Error(`官方來源連線失敗（HTTP ${res.status}）`);
    const len = Number(res.headers.get('content-length'));
    if (len > MAX_RESPONSE_BYTES) throw Error('官方回傳資料過大');
    const body = await res.text();
    if (body.length > MAX_RESPONSE_BYTES) throw Error('官方回傳資料過大');
    const data = JSON.parse(body);
    cache.set(url, { time:Date.now(), data });
    return { data, stale:false };
  })();
  cache.set(url, { ...cached, promise });
  try { return await promise; }
  catch (err) {
    if (cached?.data && Date.now() - cached.time < 24 * 3600_000) {
      cache.set(url, cached);
      return { data:cached.data, stale:true };
    }
    cache.delete(url);
    throw err;
  }
}
async function getMarket() {
  const specs = [
    ['上市', `${OFFICIAL.twse}/exchangeReport/STOCK_DAY_ALL`],
    ['上櫃', `${OFFICIAL.tpex}/tpex_mainboard_daily_close_quotes`]
  ];
  const rs = await Promise.allSettled(specs.map(async ([market, url]) => {
    const {data,stale} = await fetchJson(url);
    if (!Array.isArray(data)) throw Error(`${market}資料格式異常`);
    const rows = data.map(r=>normalize(r,market)).filter(Boolean);
    if (!rows.length) throw Error(`${market}未取得有效行情`);
    return { market, rows, stale };
  }));
  const stocks = rs.flatMap(r => r.status === 'fulfilled' ? r.value.rows : []);
  const sourceStates = rs.map((r,i) => r.status === 'fulfilled'
    ? { market:specs[i][0], available:true, stale:r.value.stale, count:r.value.rows.length,
        date:r.value.rows.find(x => x.date)?.date || null }
    : { market:specs[i][0], available:false, stale:false, count:0, date:null, message:r.reason?.message || '連線失敗' });
  if (!stocks.length) throw Error('目前無法連接證交所與櫃買中心公開行情，請稍後重試。');
  return { stocks, sources:sourceStates };
}
async function getStock(code, market) {
  const d = await getMarket();
  const stock = d.stocks.find(s => s.code === code && (!market || s.market === market));
  return { stock, sources:d.sources };
}
async function getValuation(market, code) {
  const url = market === '上市'
    ? `${OFFICIAL.twse}/exchangeReport/BWIBBU_ALL`
    : `${OFFICIAL.tpex}/tpex_mainboard_peratio_analysis`;
  const {data,stale} = await fetchJson(url, EXTRA_MS);
  if (!Array.isArray(data)) throw Error('估值資料格式異常');
  const row = data.find(r => String(pick(r,'Code','SecuritiesCompanyCode','StockCode','股票代號','證券代號') || '').trim() === code);
  if (!row) return { available:false, reason:'官方來源尚未提供此股票估值資料。', stale };
  return {
    available:true, stale, date:isoDate(pick(row,'Date','日期')),
    pe:num(pick(row,'PEratio','P E Ratio','PERatio','本益比','P/E')),
    pb:num(pick(row,'PBratio','P B Ratio','PBRatio','股價淨值比','P/B')),
    yield:num(pick(row,'DividendYield','Yield','殖利率','殖利率(%)'))
  };
}
async function getHistory(market, code) {
  if (market !== '上市') return { available:false, reason:'上櫃個股的官方歷史走勢尚未接入，其他行情功能仍可使用。' };
  const now = new Date();
  // TWSE takes Gregorian month as YYYYMM01. Use current UTC month; 3 months provide fallback for holidays.
  const months = [0,1,2].map(back => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()-back, 1));
    return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}01`;
  });
  const datasets = await Promise.allSettled(months.map(async month => {
    const url = `${OFFICIAL.twseHistory}?response=json&date=${month}&stockNo=${encodeURIComponent(code)}`;
    return await fetchJson(url, EXTRA_MS);
  }));
  const data = [];
  let stale = false;
  for (const r of datasets) {
    if (r.status !== 'fulfilled') continue;
    stale ||= r.value.stale;
    const rows = r.value.data?.data;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 7) continue;
      const date = isoDate(row[0]); const close = num(row[6]);
      if (date && close !== null) data.push({date,close});
    }
  }
  const unique = [...new Map(data.map(r=>[r.date,r])).values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-45);
  return unique.length ? {available:true, points:unique, stale} : {available:false, reason:'官方近期歷史行情暫時無法取得。'};
}
function rateLimit(req,res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].slice(0,100);
  const minute = Math.floor(Date.now()/60000);
  let rec = counts.get(ip); if (!rec || rec.minute!==minute) {rec={minute,count:0};counts.set(ip,rec)}
  rec.count++;
  if (counts.size > 3000) for (const [key,val] of counts) if(val.minute!==minute) counts.delete(key);
  if (rec.count>100) {sendJson(res,429,{error:'查詢過於頻繁，請稍後再試。'});return true}
  return false;
}
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const handler = async (req,res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (!['GET','HEAD'].includes(req.method)) return sendJson(res,405,{error:'Method Not Allowed'});
  if (url.pathname.startsWith('/api/') && rateLimit(req,res)) return;
  try {
    if (url.pathname === '/api/health') return sendJson(res,200,{ok:true, time:new Date().toISOString()});
    if (url.pathname === '/api/market') {
      const {sources} = await getMarket();
      return sendJson(res,200,{sources, type:'官方最新交易日收盤行情；非盤中即時報價'});
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q')||'').trim().slice(0,60).toLowerCase();
      if (!q) return sendJson(res,200,{stocks:[],count:0});
      const market = url.searchParams.get('market')||'';
      const {stocks,sources} = await getMarket();
      const found=stocks.filter(s=>(!market||market===s.market) && (s.code.toLowerCase().includes(q)||s.name.toLowerCase().includes(q)))
        .sort((a,b)=>{
          const score=s=>s.code.toLowerCase()===q?0:s.name.toLowerCase()===q?1:s.code.toLowerCase().startsWith(q)?2:s.name.toLowerCase().startsWith(q)?3:4;
          return score(a)-score(b)||a.code.localeCompare(b.code);
        });
      return sendJson(res,200,{stocks:found.slice(0,40),count:found.length,sources});
    }
    const extra = url.pathname.match(/^\/api\/stock\/([a-zA-Z0-9]{4,7})\/(valuation|history)$/);
    if (extra) {
      const [,code,kind] = extra; const market = url.searchParams.get('market')||'上市';
      if (!['上市','上櫃'].includes(market)) return sendJson(res,400,{error:'市場別不正確'});
      return sendJson(res,200,kind==='valuation'?await getValuation(market,code):await getHistory(market,code));
    }
    const match = url.pathname.match(/^\/api\/stock\/([a-zA-Z0-9]{4,7})$/);
    if (match) {
      const market = url.searchParams.get('market') || '';
      const {stock,sources} = await getStock(match[1],market);
      return stock ? sendJson(res,200,{stock,sources}) : sendJson(res,404,{error:'查無符合的股票，請確認代號。'});
    }
    const target = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const requested = path.resolve(ROOT, target);
    if (!(requested===ROOT || requested.startsWith(ROOT + path.sep))) return sendJson(res,403,{error:'Forbidden'});
    fs.readFile(requested,(err,data)=>{
      if (err) return sendJson(res,404,{error:'找不到頁面'});
      res.writeHead(200,{'Content-Type':mime[path.extname(requested)]||'application/octet-stream',
        'Cache-Control':target==='index.html'?'no-cache':'public, max-age=300'});
      if(req.method==='HEAD') res.end(); else res.end(data);
    });
  } catch(err) {
    console.error('[request]',url.pathname,err.message);
    sendJson(res,502,{error:err.message||'官方資料暫時無法讀取',hint:'請稍後重試，或進入互動示範試用介面。'});
  }
};
if (require.main === module) http.createServer(handler).listen(PORT,()=>console.log(`K STOCK running on port ${PORT}`));
module.exports={handler,normalize,num,isoDate,pick};
