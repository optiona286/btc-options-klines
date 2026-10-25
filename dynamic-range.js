(function (root) {
  'use strict';
  function historicalRange(bars, endMs, interval) {
    const step = { '15m':900000, '1h':3600000, '4h':14400000 }[interval];
    if (!step || !Number.isFinite(endMs)) return null;
    const day = 86400000, start = endMs - day, days = [];
    for (let ago = 2; ago >= 1; ago--) {
      const from = start - ago * day;
      const rows = bars.filter(b => b.openTime >= from && b.openTime < from + day).sort((a,b) => a.openTime-b.openTime);
      if (rows.length !== day / step || rows.some((b,i) => b.openTime !== from + i*step || !Number.isFinite(b.high) || !Number.isFinite(b.low) || b.high < b.low)) return null;
      const base = (rows[0].high + rows[0].low) / 2;
      if (!(base > 0)) return null;
      const later = rows.slice(1);
      days.push({ from, base, up:Math.max(0,(Math.max(...later.map(b=>b.high))-base)/base*100), down:Math.max(0,(base-Math.min(...later.map(b=>b.low)))/base*100) });
    }
    const maxPct = Math.max(...days.flatMap(d=>[d.up,d.down]));
    const outerPct = Math.ceil(Number((maxPct/0.5).toFixed(10))) * 0.5;
    return { days, maxPct, outerPct, innerPct:outerPct/2 };
  }
  root.btcDynamicRange = { historicalRange };
  if (typeof module !== 'undefined') module.exports = root.btcDynamicRange;
})(globalThis);
