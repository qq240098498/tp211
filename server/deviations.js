// 指令下泄流量与实际放流的偏差分析
// 口径：
// 1. 一条指令对应一个执行时段（windowStart 至 windowEnd，含两端），按"日"对齐出库流量记录；
//    同一天多条出库记录先求日均值，时段实际值 = 有实测各天日均值的平均（与指令详情里的实际均值同口径）。
// 2. 绝对偏差 = 实际均值 - 要求值（targetFlow）；正为放多了，负为放少了。
// 3. 相对偏差 = 绝对偏差 / 要求值 × 100%。
// 4. 偏差水量（万m³）= 绝对偏差 × 有实测的天数 × 86400 / 10000，
//    即实测覆盖到的这些天里多放/少放的水量（缺测的日子不外推）。
// 5. 分类（先判时段错开，再按偏差大小判方向）：
//    - 已撤销：撤销的指令不考核；
//    - 时段未结束：时段末日晚于今天，实测天数还不全；
//    - 暂无实测：时段内一天出库记录都没有；
//    - 时段错开了：有实测，但实测天数覆盖不到时段的一半；
//    - 放多了 / 放少了：|绝对偏差| > 流量容差，且 |相对偏差| > 相对容差；
//    - 基本一致：偏差在容差以内。

const store = require('./store');

// 类别 key -> 页面文案，顺序即页面上的排列顺序
const CATEGORIES = [
  { key: 'over', label: '放多了' },
  { key: 'under', label: '放少了' },
  { key: 'shifted', label: '时段错开了' },
  { key: 'matched', label: '基本一致' },
  { key: 'ongoing', label: '时段未结束' },
  { key: 'noData', label: '暂无实测' },
  { key: 'revoked', label: '已撤销' },
];

const CATEGORY_LABELS = CATEGORIES.reduce((map, item) => {
  map[item.key] = item.label;
  return map;
}, {});

function addDaysIso(dateStr, days) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3) return '';
  const t = Date.UTC(parts[0], parts[1] - 1, parts[2]) + days * 86400000;
  const d = new Date(t);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

// 时段内每一天（含两端）
function windowDays(windowStart, windowEnd) {
  const days = [];
  for (let d = windowStart; d && d <= windowEnd; d = addDaysIso(d, 1)) days.push(d);
  return days;
}

// 一天多条出库记录时取日均值；返回 { date, flow, count }
function dailyReleases(data, reservoirId) {
  const map = new Map();
  for (const r of data.releases) {
    if (r.reservoirId !== reservoirId) continue;
    if (!map.has(r.date)) map.set(r.date, []);
    map.get(r.date).push(Number(r.flow));
  }
  const out = {};
  for (const [date, flows] of map.entries()) {
    out[date] = {
      date,
      flow: store.round(flows.reduce((s, v) => s + v, 0) / flows.length, 2),
      count: flows.length,
    };
  }
  return out;
}

// 一条指令的偏差分析结果
function analyzeOrder(data, order, today) {
  const settings = data.settings;
  const reservoir = data.reservoirs.find((r) => r.id === order.reservoirId);
  const required = Number(order.targetFlow);
  const days = windowDays(order.windowStart, order.windowEnd);
  const windowDaysCount = Math.max(1, days.length);
  const dailyMap = dailyReleases(data, order.reservoirId);

  const daily = days
    .filter((d) => dailyMap[d])
    .map((d) => {
      const day = dailyMap[d];
      const deviation = store.round(day.flow - required, 2);
      return {
        date: d,
        required,
        flow: day.flow,
        count: day.count,
        deviation,
        relDeviation: required === 0 ? null : store.round((deviation / required) * 100, 2),
      };
    });
  const coveredDays = daily.length;
  const actualMean = coveredDays
    ? store.round(daily.reduce((s, x) => s + x.flow, 0) / coveredDays, 2)
    : null;
  const absDeviation = actualMean === null ? null : store.round(actualMean - required, 2);
  const relDeviation = actualMean === null || required === 0
    ? null
    : store.round((absDeviation / required) * 100, 2);
  // 偏差水量：偏差流量只按有实测的天数折算，缺测的日子不外推
  const deviationVolume = absDeviation === null
    ? null
    : store.round((absDeviation * coveredDays * 86400) / 10000, 3);

  const tolerance = Number(settings.flowDeviationTolerance) || 0;
  const tolerancePercent = Number(settings.flowDeviationPercent) || 0;
  const overTolerance = absDeviation !== null
    && (Math.abs(absDeviation) > tolerance || Math.abs(relDeviation) > tolerancePercent);

  let category;
  if (order.status === '已撤销') category = 'revoked';
  else if (order.windowEnd > today) category = 'ongoing';
  else if (coveredDays === 0) category = 'noData';
  else if (coveredDays < windowDaysCount / 2) category = 'shifted';
  else if (overTolerance && absDeviation > 0) category = 'over';
  else if (overTolerance && absDeviation < 0) category = 'under';
  else category = 'matched';

  // 实测落在时段外、离时段最近的记录，用来解释"时段错开了"（前后各取最近 3 天范围内、最多 5 条）
  const adjacent = [];
  if (category === 'shifted') {
    const nearStart = addDaysIso(order.windowStart, -3);
    const nearEnd = addDaysIso(order.windowEnd, 3);
    Object.keys(dailyMap)
      .filter((d) => (d < order.windowStart && d >= nearStart) || (d > order.windowEnd && d <= nearEnd))
      .sort()
      .slice(0, 5)
      .forEach((d) => adjacent.push(dailyMap[d]));
  }

  // 时段内缺测的日子
  const missingDays = days.filter((d) => !dailyMap[d]);

  return {
    orderId: order.id,
    code: order.code,
    reservoirId: order.reservoirId,
    reservoirName: reservoir ? reservoir.name : '',
    status: order.status,
    issuedAt: order.issuedAt,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    windowDays: windowDaysCount,
    targetFlow: required,
    actualMean,
    absDeviation,
    relDeviation,
    deviationVolume,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    coveredDays,
    missingDays,
    releaseRecordCount: daily.reduce((s, x) => s + x.count, 0),
    tolerance,
    tolerancePercent,
    daily,
    adjacentReleases: adjacent,
    reason: order.reason || '',
  };
}

function summarize(rows) {
  const groups = CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    count: 0,
    totalAbsDeviation: 0,
    totalRelDeviation: 0,
    relDeviationCount: 0,
    totalVolumeWan: 0,
  }));
  const byKey = {};
  groups.forEach((g) => { byKey[g.key] = g; });

  for (const row of rows) {
    const g = byKey[row.category];
    if (!g) continue;
    g.count += 1;
    // 考核类（放多/放少/错开/基本一致）才合计偏差；未撤销、有实测
    if (row.absDeviation !== null && row.category !== 'revoked' && row.category !== 'ongoing' && row.category !== 'noData') {
      g.totalAbsDeviation = store.round(g.totalAbsDeviation + row.absDeviation, 2);
      g.totalVolumeWan = store.round(g.totalVolumeWan + row.deviationVolume, 3);
      if (row.relDeviation !== null) {
        g.totalRelDeviation = store.round(g.totalRelDeviation + Math.abs(row.relDeviation), 2);
        g.relDeviationCount += 1;
      }
    }
  }
  groups.forEach((g) => {
    g.avgRelDeviation = g.relDeviationCount ? store.round(g.totalRelDeviation / g.relDeviationCount, 2) : null;
  });
  return groups;
}

// GET /api/deviations
function report(data, query) {
  const q = query || {};
  const today = store.todayIso();
  let orders = data.orders.slice();
  if (q.reservoirId) orders = orders.filter((o) => o.reservoirId === q.reservoirId);
  if (q.status) orders = orders.filter((o) => o.status === q.status);
  if (q.category) orders = orders.filter((o) => analyzeOrder(data, o, today).category === q.category);
  orders.sort((a, b) => (a.code < b.code ? -1 : 1));

  const rows = orders.map((o) => analyzeOrder(data, o, today));
  const groups = summarize(rows);
  const assessed = rows.filter((r) => r.category === 'over' || r.category === 'under' || r.category === 'shifted');
  return {
    today,
    tolerance: Number(data.settings.flowDeviationTolerance) || 0,
    tolerancePercent: Number(data.settings.flowDeviationPercent) || 0,
    totalCount: rows.length,
    assessedCount: assessed.length,
    groups,
    rows,
  };
}

module.exports = { report, analyzeOrder, CATEGORIES, CATEGORY_LABELS };
