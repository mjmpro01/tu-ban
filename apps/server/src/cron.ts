import { parseCron } from "@tu-ban/shared";
import { tzOffsetMs } from "./budget.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The first time after `after` that matches the cron expression, in the server's time zone.
 * Walks the wall clock (skipping whole months, days and hours that cannot match), then converts back.
 */
export function nextRun(expr: string, after = Date.now()): number {
  const c = parseCron(expr);
  const minute = new Set(c.minute);
  const hour = new Set(c.hour);
  const dom = new Set(c.dom);
  const month = new Set(c.month);
  const dow = new Set(c.dow);
  const dayMatches = (d: Date) => {
    const a = dom.has(d.getUTCDate());
    const b = dow.has(d.getUTCDay());
    // cron rule: when both day fields are restricted, either one may match
    if (!c.domAny && !c.dowAny) return a || b;
    return a && b;
  };
  // wall-clock time, kept in a Date's UTC fields
  let local = Math.floor((after + tzOffsetMs(after)) / MINUTE) * MINUTE + MINUTE;
  const limit = local + 5 * 366 * 24 * HOUR;
  while (local < limit) {
    const d = new Date(local);
    if (!month.has(d.getUTCMonth() + 1)) {
      local = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      continue;
    }
    if (!dayMatches(d)) {
      local = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    if (!hour.has(d.getUTCHours())) {
      local = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!minute.has(d.getUTCMinutes())) {
      local += MINUTE;
      continue;
    }
    const utc = local - tzOffsetMs(local - tzOffsetMs(local));
    if (utc > after) return utc;
    local += MINUTE;
  }
  throw new Error("Lịch này không bao giờ chạy (ví dụ ngày 31 tháng 2)");
}
