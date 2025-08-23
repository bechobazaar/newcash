const DAY_MS = 24 * 60 * 60 * 1000;

const PLAN = {
  PLAN_29_3D:  { code:'29-3d', label:'29-3d',  kind:'ONE',     days:3  }, // single bump at activation
  PLAN_49_15D: { code:'49-15d',label:'49-15d', kind:'WEEKLY2', days:15 }, // +7d & +14d bumps
  PLAN_99_30D: { code:'99-30d',label:'99-30d', kind:'DAILY1',  days:30 }  // 1 per 24h
};

// Normalize input like 'PLAN_99_30D' | '99' | '99-30d'
function resolvePlan(planCode) {
  if (!planCode) return null;
  const p = String(planCode).toUpperCase().trim();
  if (PLAN[p]) return PLAN[p];

  // accept short codes
  if (p === '99' || p === '99-30D') return PLAN.PLAN_99_30D;
  if (p === '49' || p === '49-15D') return PLAN.PLAN_49_15D;
  if (p === '29' || p === '29-3D')  return PLAN.PLAN_29_3D;
  return null;
}

// Prepare bumpSchedule for weekly plan (absolute ms)
function buildWeeklyTwoSchedule(startMs, days) {
  const a = startMs + 7 * DAY_MS;
  const b = startMs + 14 * DAY_MS;
  const endMs = startMs + days * DAY_MS;
  return [a, b].filter(t => t < endMs);
}

// Compute next bump after "last" depending on plan
function computeNextBump(plan, startMs, lastBumpedMs, endMs, bumpSchedule=[]) {
  if (!plan) return null;
  switch (plan.kind) {
    case 'ONE':
      return null;
    case 'DAILY1': {
      const next = (lastBumpedMs || startMs) + DAY_MS;
      return next < endMs ? next : null;
    }
    case 'WEEKLY2': {
      const future = (bumpSchedule || []).filter(t => t > Date.now());
      const next = future.length ? future[0] : null;
      return (next && next < endMs) ? next : null;
    }
    default:
      return null;
  }
}

module.exports = { PLAN, DAY_MS, resolvePlan, buildWeeklyTwoSchedule, computeNextBump };
