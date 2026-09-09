const fs = require("node:fs");
const path = require("node:path");
const { rows, ANALYSIS_AT, assertData, toCsv, DESIGN } = require("./generate-cx-data.cjs");

// Verify the actual shipped file before using the independently generated expectations.
const sourcePath = path.join(__dirname, "..", "data", "cx-tickets-2026-08.csv");
const sourceText = fs.readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
if (sourceText !== toCsv()) throw new Error("Shipped sample CSV differs from the validated sample data");

const parseSeoul = (value) => value ? new Date(`${value.replace(" ", "T")}+09:00`) : null;
const tickets = rows.map((row) => ({
  ...row,
  createdAt: parseSeoul(row.created_at),
  resolvedAt: parseSeoul(row.resolved_at),
}));
const isUnresolved = (ticket) => ticket.status !== "해결";
const isAged = (ticket) => isUnresolved(ticket) && (ANALYSIS_AT - ticket.createdAt) / 36e5 >= 48;

function calculate(list) {
  const resolvedDurations = list
    .filter((ticket) => ticket.status === "해결")
    .map((ticket) => (ticket.resolvedAt - ticket.createdAt) / 36e5)
    .sort((a, b) => a - b);
  const middle = Math.floor(resolvedDurations.length / 2);
  const median = !resolvedDurations.length
    ? null
    : resolvedDurations.length % 2
      ? resolvedDurations[middle]
      : (resolvedDurations[middle - 1] + resolvedDurations[middle]) / 2;
  return {
    total: new Set(list.map((ticket) => ticket.ticket_id)).size,
    unresolved: list.filter(isUnresolved).length,
    aged: list.filter(isAged).length,
    medianHours: median === null ? null : Math.round(median * 10) / 10,
  };
}

function filter({ start = "2026-08-01", end = "2026-08-31", category = "all", status = "all" }) {
  return tickets.filter((ticket) => {
    const date = ticket.created_at.slice(0, 10);
    return date >= start && date <= end
      && (category === "all" || ticket.category === category)
      && (status === "all" || ticket.status === status);
  });
}

assertData();

const statusCounts = Object.fromEntries(["미처리", "처리중", "해결"].map((status) => [status, tickets.filter((ticket) => ticket.status === status).length]));
if (Object.values(statusCounts).reduce((sum, count) => sum + count, 0) !== tickets.length) throw new Error("Status total mismatch");
const full = calculate(tickets);
if (full.aged > full.unresolved) throw new Error("Aged count exceeds unresolved count");
if (statusCounts.해결 < 320 || statusCounts.해결 > 345 || statusCounts.처리중 < 45 || statusCounts.처리중 > 65
  || statusCounts.미처리 < 20 || statusCounts.미처리 > 35 || full.unresolved < 70 || full.unresolved > 95
  || full.aged < 20 || full.aged > 40 || full.medianHours < 10 || full.medianHours > 24) throw new Error("Sample realism target mismatch");
const countBy = (key) => Object.fromEntries([...new Set(tickets.map(ticket => ticket[key]))].map(value => [value, tickets.filter(ticket => ticket[key] === value).length]));
const categoryCounts = countBy("category");
for (const [category, count] of DESIGN) {
  if (categoryCounts[category] !== count) throw new Error(`Category mismatch: ${category}`);
}
const refund = tickets.filter(ticket => ticket.category === "결제·환불" && ["환불 기준", "환불 진행상태"].includes(ticket.subcategory));
const urgentOutage = tickets.filter(ticket => ticket.category === "오류·장애" && ticket.priority === "긴급");
const patterns = {
  refund: calculate(refund),
  accessAged: tickets.filter(ticket => ticket.category === "계정·접근" && isAged(ticket)).length,
  urgentOutage: calculate(urgentOutage),
  loginMidMonth: tickets.filter(ticket => ticket.category === "계정·접근" && ["로그인 실패", "인증 오류"].includes(ticket.subcategory) && ticket.created_at.slice(0, 10) >= "2026-08-16" && ticket.created_at.slice(0, 10) <= "2026-08-20").length,
};

const resolvedOnly = calculate(filter({ status: "해결" }));
if (resolvedOnly.unresolved !== 0 || resolvedOnly.aged !== 0) throw new Error("Resolved-only KPI mismatch");
const openOnly = calculate(filter({ status: "미처리" }));
const progressOnly = calculate(filter({ status: "처리중" }));
if (openOnly.medianHours !== null || progressOnly.medianHours !== null) throw new Error("Unresolved median must be null");

const checks = {
  source: "data/cx-tickets-2026-08.csv",
  analysisAt: "2026-08-31 23:59:59 Asia/Seoul",
  full,
  statusCounts,
  categoryCounts,
  priorityCounts: countBy("priority"),
  channelCounts: countBy("channel"),
  patterns,
  filters: {
    resolvedOnly,
    openOnly,
    progressOnly,
    payment: calculate(filter({ category: "결제·환불" })),
    loginSurgeWindow: calculate(filter({ start: "2026-08-16", end: "2026-08-20", category: "계정·접근" })),
    firstDay: calculate(filter({ start: "2026-08-01", end: "2026-08-01" })),
    lastDay: calculate(filter({ start: "2026-08-31", end: "2026-08-31" })),
    emptyCombination: calculate(filter({ start: "2026-08-01", end: "2026-08-01", category: "기타", status: "미처리" })),
  },
};

process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
