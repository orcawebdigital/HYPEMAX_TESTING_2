const { bad } = require("../../util");

// Date ranges are interpreted in India Standard Time (UTC+5:30); the DB stores UTC.
const IST = 330 * 60e3;
const istMidnight = (d) => { const x = new Date(d.getTime() + IST); x.setUTCHours(0, 0, 0, 0); return new Date(x.getTime() - IST); };

function resolveRange(query) {
  const now = new Date();
  const today = istMidnight(now);
  const day = 864e5;
  let from, to = now, label;
  switch (query.range || "30d") {
    case "today": from = today; label = "Today"; break;
    case "yesterday": from = new Date(today - day); to = today; label = "Yesterday"; break;
    case "7d": from = new Date(today - 6 * day); label = "Last 7 days"; break;
    case "30d": from = new Date(today - 29 * day); label = "Last 30 days"; break;
    case "month": { const x = new Date(now.getTime() + IST); from = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1) - IST); label = "This month"; break; }
    case "year": { const x = new Date(now.getTime() + IST); from = new Date(Date.UTC(x.getUTCFullYear(), 0, 1) - IST); label = "This year"; break; }
    case "all": from = new Date("2000-01-01T00:00:00Z"); label = "All time"; break;
    case "custom": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(query.from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(query.to || "")) throw bad("Choose a start and end date");
      from = new Date(Date.parse(query.from + "T00:00:00Z") - IST);
      to = new Date(Date.parse(query.to + "T00:00:00Z") - IST + day);
      if (!(from < to)) throw bad("Start date must be before end date");
      if (to - from > 3 * 366 * day) throw bad("Custom ranges can cover at most 3 years");
      label = `${query.from} to ${query.to}`;
      break;
    }
    default: throw bad("Unknown date range");
  }
  return { from, to, label, days: Math.ceil((to - from) / day) };
}

module.exports = { resolveRange, IST };
