'use strict';
// 盤後公開資料的欄位標準化。欄位缺失時回傳 null，不推測或填入假數值。
function pick(row, ...fields) {
  if (!row || typeof row !== 'object') return null;
  const keys = Object.keys(row);
  const norm = x => String(x).toLowerCase().replace(/[\s()（）_\-—.:：]/g,'');
  for (const field of fields) {
    const key = keys.find(k => k === field) || keys.find(k => norm(k) === norm(field));
    if (key && row[key] != null && String(row[key]).trim() !== '') return row[key];
  }
  return null;
}
function number(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).replace(/[,\s]/g,'').replace(/[＋+▲△]/g,'+').replace(/[－−▼▽]/g,'-');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(str)) return null;
  const x = Number(str);return Number.isFinite(x) ? x : null;
}
function dateISO(value){
  if(value===null||value===undefined)return null;
  const s=String(value).replace(/[＊*]/g,'').trim();
  if (/^\d{7}$/.test(s)) return `${Number(s.slice(0,3))+1911}-${s.slice(3,5)}-${s.slice(5,7)}`;
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  if (/^\d{2,4}[\/-]\d{1,2}[\/-]\d{1,2}$/.test(s)){
    const [yr,mo,dy]=s.split(/[\/-]/).map(Number);const y=yr < 1911 ? yr+1911 : yr;
    if(mo<1||mo>12||dy<1||dy>31)return null;
    return `${y}-${String(mo).padStart(2,'0')}-${String(dy).padStart(2,'0')}`;
  }
  return null;
}
const recordCode = row => String(pick(row,'股票代號','證券代號','SecuritiesCompanyCode','Code','StockCode')||'').trim().toUpperCase();
function normalizeMargin(row,market){
  if(!row)return null;
  const isTWSE=market==='上市';
  const currentLong=number(pick(row,'融資今日餘額','資餘額','MarginPurchaseBalance'));
  const previousLong=number(pick(row,'融資前日餘額','前資餘額','MarginPurchaseBalancePreviousDay'));
  const currentShort=number(pick(row,'融券今日餘額','券餘額','ShortSaleBalance'));
  const previousShort=number(pick(row,'融券前日餘額','前券餘額','ShortSaleBalancePreviousDay'));
  if(currentLong===null&&currentShort===null)return null;
  return {
    available:true, market, code:recordCode(row),
    date:dateISO(pick(row,'Date','資料日期','日期')), // TWSE MI_MARGN 部分資料列不含日期：不得推測
    longBalance:currentLong, longPrevious:previousLong,
    longChange:currentLong!=null&&previousLong!=null?currentLong-previousLong:null,
    shortBalance:currentShort, shortPrevious:previousShort,
    shortChange:currentShort!=null&&previousShort!=null?currentShort-previousShort:null,
    note:String(pick(row,isTWSE?'註記':'Remarks','備註','Note')||'').slice(0,100),
    unit:'張', // 官方 MI_MARGN、TPEx 融資券日餘額欄為張
    source:isTWSE?'臺灣證券交易所 OpenAPI':'證券櫃檯買賣中心 OpenAPI',
    sourceUrl:isTWSE?'https://openapi.twse.com.tw/':'https://www.tpex.org.tw/openapi/'
  };
}
function normalizeInstitutional(row){
  if(!row)return null;
  // 櫃買中心「三大法人買賣超合計」採外陸資不含外資自營商 + 投信 + 自營商。
  const excluded=number(pick(row,
    'Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference',
    'ForeignInvestorsIncludeMainlandAreaInvestors(ForeignDealersExcluded)-Difference',
    '外資及陸資不含外資自營商買賣超股數',
    '外資及陸資買賣超股數(不含自營商)'));
  const included=number(pick(row,'ForeignInvestorsInclude MainlandAreaInvestors-Difference','ForeignInvestorsIncludeMainlandAreaInvestors-Difference'));
  const fDealer=number(pick(row,'ForeignDealers-Difference'));
  const foreign=excluded!==null?excluded:included!==null&&fDealer!==null?included-fDealer:null;
  const trust=number(pick(row,'SecuritiesInvestmentTrustCompanies-Difference','投信買賣超股數'));
  const dealer=number(pick(row,'Dealers-Difference','自營商買賣超股數'));
  const officialTotal=number(pick(row,'TotalDifference','三大法人買賣超股數合計'));
  if(foreign===null&&trust===null&&dealer===null&&officialTotal===null)return null;
  const total=officialTotal!==null?officialTotal:(foreign!=null&&trust!=null&&dealer!=null?foreign+trust+dealer:null);
  return {
    available:true, code:recordCode(row),date:dateISO(pick(row,'Date','資料日期','日期')),
    foreign,trust,dealer,total, totalCalculated:officialTotal===null&&total!==null,
    unit:'股',source:'證券櫃檯買賣中心 OpenAPI',sourceUrl:'https://www.tpex.org.tw/openapi/'
  };
}
function normalizeHistoryEntry(row,market){
  if(!Array.isArray(row)||row.length<7)return null;
  const d=dateISO(row[0]);const close=number(row[6]);
  if(!d||close===null||close<=0)return null;
  return {
    date:d,open:number(row[3]),high:number(row[4]),low:number(row[5]),close,
    // 上市原表單位為股；上櫃原表是張，轉換為股。
    volume:(v=>v===null?null:Math.round(v*(market==='上櫃'?1000:1)))(number(row[1]))
  };
}
function indicators(points){
  const periods=[5,10,20,60];
  const candles=points.map((p,i)=>{
    const mas={};for(const period of periods){const slice=points.slice(i-period+1,i+1);mas['ma'+period]=slice.length===period&&slice.every(x=>Number.isFinite(x.close))?Number((slice.reduce((a,x)=>a+x.close,0)/period).toFixed(3)):null;}
    return {...p,...mas};
  });
  const latest=candles.at(-1);
  return {available:Boolean(latest),date:latest?.date||null,candles:candles.slice(-90),
    latest:latest?{close:latest.close,ma5:latest.ma5,ma10:latest.ma10,ma20:latest.ma20,ma60:latest.ma60,ma20Deviation:latest.ma20!=null&&latest.ma20>0?Number(((latest.close/latest.ma20-1)*100).toFixed(2)):null}:null};
}
module.exports={pick,number,dateISO,recordCode,normalizeMargin,normalizeInstitutional,normalizeHistoryEntry,indicators};
