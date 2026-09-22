const AuditLog = require('../models/AuditLog');
// Fix round 1, Minor 7: reuse the codebase's existing strict 24-hex check
// instead of re-implementing one against mongoose's looser ObjectId.isValid
// (see that function's own comment) — behaviour-equivalent on this mongoose
// version, one fewer thing to keep in sync.
const { isValidObjectId } = require('../utils/security');

// Only used as an integer with a fallback when the query value is missing or
// non-numeric (addendum E: "non-numeric values fall back to the defaults").
// Fix round 1, Minor 6: `parseInt('5abc', 10)` is 5 — a PARTIAL number must
// fall back to the default too, so this uses `Number`, which rejects any
// trailing garbage, instead of `parseInt`, which stops at it.
function parseIntOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function createAuditLogController() {
  async function listAuditLog(req, res) {
    try {
      const { actor_id: actorId, action, from, to } = req.query;
      const filter = {};

      // action/actor_id must be plain strings — a query object such as
      // `?action[$ne]=x` parses to an object, not a string, and is ignored
      // rather than passed into the Mongo filter (addendum E).
      if (isValidObjectId(actorId)) filter.actor_id = actorId;
      if (typeof action === 'string' && action) filter.action = action;

      const dateFilter = {};
      if (typeof from === 'string' && from) {
        const fromDate = new Date(from);
        if (!Number.isNaN(fromDate.getTime())) dateFilter.$gte = fromDate;
      }
      if (typeof to === 'string' && to) {
        const toDate = new Date(to);
        if (!Number.isNaN(toDate.getTime())) {
          if (DATE_ONLY.test(to)) {
            // Addendum E: a date-only `to` (from a <input type="date">) must
            // be INCLUSIVE of that whole day — filter for created_date
            // strictly before the NEXT day, not <= midnight of that day.
            const exclusiveEnd = new Date(toDate.getTime());
            exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
            dateFilter.$lt = exclusiveEnd;
          } else {
            dateFilter.$lte = toDate;
          }
        }
      }
      if (Object.keys(dateFilter).length > 0) filter.created_date = dateFilter;

      const rawLimit = parseIntOr(req.query.limit, 50);
      const limit = Math.min(Math.max(rawLimit, 1), 200);
      const rawPage = parseIntOr(req.query.page, 1);
      const page = Math.max(rawPage, 1);
      const skip = (page - 1) * limit;

      const [entries, total] = await Promise.all([
        AuditLog.find(filter).sort({ created_date: -1 }).skip(skip).limit(limit).lean(),
        AuditLog.countDocuments(filter),
      ]);

      return res.json({ entries, total, page, limit });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to load audit log' });
    }
  }

  return { listAuditLog };
}

module.exports = { createAuditLogController };
