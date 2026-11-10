'use strict';
// K STOCK 個股盤後分析介面：只顯示伺服器核對過的官方數據。
window.KStockAnalytics = (()=>{
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const val=(n,d=2)=>n==null||!Number.isFinite(Number(n))?'—':Number(n).toLocaleString('zh-TW',{minimumFractionDigits:d,maximumFractionDigits:d});
  const direction=n=>n>0?'rise':n<0?'fall':'neutral';
  const signed=(n,unit='',digits=0)=>n==null?'—':`${n>0?'+':''}${val(n,digits)}${unit}`;
  const link=(url,label='開啟官方資料來源')=>/^https:\/\/(www\.twse\.com\.tw|openapi\.twse\.com\.tw|www\.tpex\.org\.tw)\//.test(url||'')?`<a class="analytics-source-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`:'';
  const note=(d,extra='')=>`<div class="analytics-footnote">${d?.stale?'⚠ 來源目前顯示伺服器快取資料 · ':''}${extra}${d?.source?` · 資料來源：${esc(d.source)}`:''} ${link(d?.sourceUrl)}</div>`;
  const tile=(label,value,caption='',signedValue=false)=>`<div class="analysis-tile"><span>${esc(label)}</span><strong class="${signedValue?direction(value):''}">${signedValue?signed(value):val(value,0)}</strong><small>${esc(caption)}</small></div>`;
  function empty(d,kind){const url=d?.sourceUrl;return `<div class="analysis-empty"><div class="analysis-empty-icon">◎</div><h4>${esc(d?.licensePending?'請由官方查詢上市三大法人':'此項盤後資料目前無法顯示')}</h4><p>${esc(d?.reason||'官方資料暫不可用，請稍後重試。')}</p>${link(url,'前往官方查詢頁')}</div>`}
  function renderInst(d){
    if(!d.available)return empty(d);
    const values=[['外資及陸資（不含外資自營商）',d.foreign],['投信',d.trust],['自營商',d.dealer],['三大法人合計',d.total]];
    const maximum=Math.max(1,...values.map(x=>Math.abs(x[1]||0)));
    return `<div class="analysis-heading"><div><h4>三大法人買賣超</h4><small>資料日期：${esc(d.date||'官方未提供日期')} · 單位：張（由股數換算）</small></div><span class="analysis-flag">盤後公告</span></div>
      <div class="analysis-tiles">${values.map(([label,n])=>`<div class="analysis-tile"><span>${esc(label)}</span><strong class="${direction(n)}">${signed(n==null?null:n/1000,' 張',1)}</strong><div class="analysis-bar"><i class="${direction(n)}" style="width:${n==null?0:Math.abs(n)/maximum*100}%"></i></div></div>`).join('')}</div>
      <p class="data-hint">正數代表買超、負數代表賣超。外資採不含外資自營商口徑，避免與自營商重複計算。${d.totalCalculated?'合計由本站依三類加總計算。':''}</p>${note(d)}`;
  }
  function renderMargin(d){
    if(!d.available)return empty(d);
    return `<div class="analysis-heading"><div><h4>融資融券餘額</h4><small>資料日期：${esc(d.date||'官方該筆資料未提供日期')} · 單位：張</small></div><span class="analysis-flag">盤後公告</span></div>
    <div class="analysis-tiles">${tile('融資餘額',d.longBalance,'張')}${tile('融資較前日增減',d.longChange,'張',true)}${tile('融券餘額',d.shortBalance,'張')}${tile('融券較前日增減',d.shortChange,'張',true)}</div>
    <div class="analysis-smalltext">${d.note?`官方註記：${esc(d.note)} · `:''}餘額係官方公布的信用交易資料，非散戶持股或做空方向的完整指標。</div>${note(d)}`;
  }
  function renderCandles(records){
    const bars=records.filter(r=>[r.open,r.high,r.low,r.close].every(Number.isFinite)&&r.low>0&&r.high>=r.low).slice(-36);
    if(bars.length<2)return `<div class="chart-notice">有效開高低收資料不足，無法顯示日 K 線。</div>`;
    const width=720, priceTop=17, priceBottom=209, volumeTop=228,volumeBottom=275,padL=45,padR=25;
    const low=Math.min(...bars.map(d=>d.low)),high=Math.max(...bars.map(d=>d.high));const gap=Math.max((high-low)*.15,high*.015,1);
    const min=low-gap,max=high+gap;const y=v=>priceBottom-(v-min)/(max-min)*(priceBottom-priceTop);
    const dx=(width-padL-padR)/bars.length;const cx=i=>padL+dx*(i+.5);
    const maxVol=Math.max(1,...bars.map(d=>Number.isFinite(d.volume)?d.volume:0));
    const grid=[0,1,2,3].map(i=>{const yy=priceTop+(priceBottom-priceTop)*i/3;const v=max-(max-min)*i/3;return `<path d="M${padL} ${yy.toFixed(1)}H${width-padR}" stroke="#344558" stroke-width=".8" stroke-dasharray="3 7"/><text x="${padL-6}" y="${(yy+4).toFixed(1)}" text-anchor="end" font-size="10" fill="#8aa3b9">${val(v,1)}</text>`}).join('');
    const candles=bars.map((d,i)=>{
      const x=cx(i),yo=y(d.open),yc=y(d.close),yh=y(d.high),yl=y(d.low),isUp=d.close>=d.open;
      const col=isUp?'#f77483':'#63c5a4';const bh=Math.max(1.2,Math.abs(yo-yc));const w=Math.max(3,Math.min(13,dx*.55));
      const volumeHeight=(Number.isFinite(d.volume)?Math.max(1,d.volume/maxVol*(volumeBottom-volumeTop)):0);
      return `<path d="M${x.toFixed(1)} ${yh.toFixed(1)}V${yl.toFixed(1)}" stroke="${col}" stroke-width="1.4"/><rect x="${(x-w/2).toFixed(1)}" y="${Math.min(yo,yc).toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" rx="1"/><rect x="${(x-w/2).toFixed(1)}" y="${(volumeBottom-volumeHeight).toFixed(1)}" width="${w.toFixed(1)}" height="${volumeHeight.toFixed(1)}" fill="${col}" opacity=".65"/>`;
    }).join('');
    const maPath=(key,color)=>{let segments=[],current=[];bars.forEach((p,i)=>{if(p[key]!=null&&Number.isFinite(p[key]))current.push(`${current.length?'L':'M'}${cx(i).toFixed(1)} ${y(p[key]).toFixed(1)}`);else{if(current.length>1)segments.push(current.join(' '));current=[]}});if(current.length>1)segments.push(current.join(' '));return segments.map(x=>`<path d="${x}" fill="none" stroke="${color}" stroke-width="2.1"/>`).join('')};
    const dates=[0,Math.round((bars.length-1)/2),bars.length-1].map((i,j)=>`<text x="${cx(i).toFixed(1)}" y="297" fill="#8298ad" font-size="11" text-anchor="${j===0?'start':j===2?'end':'middle'}">${esc(bars[i].date.slice(5))}</text>`).join('');
    return `<div class="candle-wrap"><div class="candle-legend"><span><i class="legend-red"></i>上漲（日Ｋ）</span><span><i class="legend-green"></i>下跌（日Ｋ）</span><span><i class="legend-yellow"></i>MA5</span><span><i class="legend-aqua"></i>MA20</span></div><svg viewBox="0 0 720 304" role="img" aria-label="近 ${bars.length} 個交易日的日 K 線與成交量，含 MA5 及 MA20">${grid}<path d="M${padL} ${volumeTop}H${width-padR}" stroke="#344558"/><text x="4" y="246" fill="#8aa3b9" font-size="10">量</text>${candles}${maPath('ma5','#f6c979')}${maPath('ma20','#86e8d7')}${dates}</svg></div>`;
  }
  function renderTechnical(d){
    if(!d.available)return empty(d);
    const l=d.latest||{};
    const row=(c)=>`<tr><td>${esc(c.date)}</td><td>${val(c.open)}</td><td>${val(c.high)}</td><td>${val(c.low)}</td><td>${val(c.close)}</td><td>${c.volume==null?'—':val(c.volume/1000,0)}</td></tr>`;
    return `<div class="analysis-heading"><div><h4>日 K 線與均線分析</h4><small>最近交易日：${esc(d.date||'未提供')} · 有效資料 ${val(d.pointsCount,0)} 日</small></div><span class="analysis-flag">未還原</span></div>
      <div class="analysis-tiles analysis-ma-tiles">${[5,10,20,60].map(n=>tile(`MA${n} 日均線`,l['ma'+n],'元')).join('')}</div>
      <div class="analysis-smalltext">最新收盤：${val(l.close)} 元　·　乖離率（收盤／MA20 − 1）：<b class="${direction(l.ma20Deviation)}">${signed(l.ma20Deviation,'%',2)}</b></div>
      ${renderCandles(d.candles||[])}
      <h5 class="analysis-table-title">最近交易日明細</h5><div class="analysis-table-wrap"><table class="analysis-table"><thead><tr><th>交易日</th><th>開盤</th><th>最高</th><th>最低</th><th>收盤</th><th>量（張）</th></tr></thead><tbody>${(d.candles||[]).slice(-5).reverse().map(row).join('')}</tbody></table></div>
      <p class="data-hint">${esc(d.note||'均線由官方歷史收盤價計算。')} 不是即時價格；不足 60 個有效交易日的均線會顯示「—」。</p>${note(d)}`;
  }
  function render(tab,data,stock,demo){
    if(demo)return `<div class="analysis-empty"><h4>互動示範未提供籌碼與技術數據</h4><p>請按「返回官方行情」後查詢真實股票；此區不使用虛構的法人或融資資料。</p></div>`;
    if(!data||data.loading)return `<div class="analysis-empty"><h4>正在取得盤後資料…</h4><p>官方資料需要一點時間，請勿重複點擊。</p></div>`;
    if(tab==='institutional')return renderInst(data);
    if(tab==='margin')return renderMargin(data);
    if(tab==='technical')return renderTechnical(data);
    return '';
  }
  return {render};
})();
