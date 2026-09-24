// 调度指令的偏差分析：要求值、实际值、绝对偏差、相对偏差、偏差水量与分类都集中在这里
const store = require('./store');

// 分类的固定顺序：接口、卡片与表格都按这个顺序排
const CATEGORIES = [
  { key: 'over', name: '放多了' },
  { key: 'under', name: '放少了' },
  { key: 'shifted', name: '时段错开了' },
  { key: 'match', name: '基本符合' },
  { key: 'nodata', name: '无数据' },
];

const CATEGORY_NAMES = {};
for (const c of CATEGORIES) CATEGORY_NAMES[c.key] = c.name;

// 日期串平移 N 天（可为负），返回 年-月-日
function shiftDate(dateStr, days) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return '';
  const t = Date.UTC(parts[0], parts[1] - 1, parts[2]) + days * 86400000;
  const d = new Date(t);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function toleranceOf(settings) {
  const tol = Number(settings.deviationTolerancePct);
  return Number.isFinite(tol) ? tol : 5;
}

function shiftDaysOf(settings) {
  const days = Number(settings.deviationShiftDays);
  return Number.isFinite(days) && days > 0 ? days : 7;
}

// 单条指令：要求值取目标下泄流量，实际值取指令时段（含首尾两天）内出库流量的均值
function analyzeOrder(data, order) {
  const settings = data.settings;
  const reservoir = data.reservoirs.find((r) => r.id === order.reservoirId);
  const windowDays = store.daysBetween(order.windowStart, order.windowEnd) + 1;
  const inWindow = data.releases.filter(
    (r) => r.reservoirId === order.reservoirId && r.date >= order.windowStart && r.date <= order.windowEnd
  );
  const coveredDays = new Set(inWindow.map((r) => r.date)).size;
  const coverage = windowDays > 0 ? coveredDays / windowDays : 0;

  // 时段前后各 shiftDays 天内的出库记录，用来判断「时段错开了」
  const shiftDays = shiftDaysOf(settings);
  const before = shiftDate(order.windowStart, -shiftDays);
  const after = shiftDate(order.windowEnd, shiftDays);
  const outsideCount = data.releases.filter(
    (r) => r.reservoirId === order.reservoirId
      && ((r.date >= before && r.date < order.windowStart) || (r.date > order.windowEnd && r.date <= after))
  ).length;

  const targetFlow = Number(order.targetFlow);
  const actualMean = inWindow.length ? store.round(inWindow.reduce((s, r) => s + Number(r.flow), 0) / inWindow.length, 2) : null;
  const absDeviation = actualMean === null ? null : store.round(actualMean - targetFlow, 2);
  const relativeDeviationPct = absDeviation === null || !(targetFlow > 0) ? null : store.round((absDeviation / targetFlow) * 100, 2);
  const deviationVolumeWan = absDeviation === null ? null : store.round((absDeviation * windowDays * 86400) / 10000, 3);

  let category;
  if (coverage < 0.5) category = outsideCount > 0 ? 'shifted' : 'nodata';
  else if (relativeDeviationPct === null) category = 'nodata';
  else if (Math.abs(relativeDeviationPct) <= toleranceOf(settings)) category = 'match';
  else category = relativeDeviationPct > 0 ? 'over' : 'under';

  return {
    id: order.id,
    code: order.code,
    reservoirId: order.reservoirId,
    reservoirName: reservoir ? reservoir.name : '',
    status: order.status,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    windowDays,
    targetFlow,
    actualMean,
    absDeviation,
    relativeDeviationPct,
    deviationVolumeWan,
    category,
    categoryName: CATEGORY_NAMES[category],
    releaseCount: inWindow.length,
    coveredDays,
    outsideCount,
  };
}

// 带符号求和：没有一条有值时返回 null（页面显示 —），否则返回四舍五入后的合计
function sumRounded(rows, field, digits) {
  let sum = 0;
  let seen = false;
  for (const row of rows) {
    const value = row[field];
    if (value === null || value === undefined) continue;
    sum += Number(value);
    seen = true;
  }
  return seen ? store.round(sum, digits) : null;
}

function analyze(data, query) {
  const q = query || {};
  let orders = data.orders.map((o) => analyzeOrder(data, o));
  if (q.reservoirId) orders = orders.filter((o) => o.reservoirId === q.reservoirId);
  if (q.status) orders = orders.filter((o) => o.status === q.status);

  // 分类合计按水库与状态筛选后的全集算，category 筛选只影响明细行
  const categories = CATEGORIES.map((c) => {
    const bucket = orders.filter((o) => o.category === c.key);
    return {
      key: c.key,
      name: c.name,
      count: bucket.length,
      totalDeviation: sumRounded(bucket, 'absDeviation', 2),
      totalVolumeWan: sumRounded(bucket, 'deviationVolumeWan', 3),
    };
  });

  const totals = {
    orderCount: orders.length,
    totalDeviation: sumRounded(orders, 'absDeviation', 2),
    totalVolumeWan: sumRounded(orders, 'deviationVolumeWan', 3),
  };

  let rows = orders;
  if (q.category) rows = rows.filter((o) => o.category === q.category);
  const rank = {};
  CATEGORIES.forEach((c, i) => { rank[c.key] = i; });
  rows = rows.slice().sort((a, b) => {
    if (rank[a.category] !== rank[b.category]) return rank[a.category] - rank[b.category];
    const ar = a.relativeDeviationPct === null ? -1 : Math.abs(a.relativeDeviationPct);
    const br = b.relativeDeviationPct === null ? -1 : Math.abs(b.relativeDeviationPct);
    if (ar !== br) return br - ar;
    return a.code < b.code ? -1 : 1;
  });

  return {
    generatedAt: store.todayIso(),
    tolerancePct: toleranceOf(data.settings),
    shiftDays: shiftDaysOf(data.settings),
    totals,
    categories,
    orders: rows,
  };
}

module.exports = { analyze, analyzeOrder, CATEGORIES };
