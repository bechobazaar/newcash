import { getFirestore, admin } from "./_firebaseAdmin.js";

/**
 * IST helpers
 */
const IST_OFFSET_MIN = 330; // +05:30
const MS_PER_MIN = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MIN;

function nowUtc() {
  return new Date();
}

function toISTDate(msUtc) {
  return new Date(msUtc + IST_OFFSET_MIN * MS_PER_MIN);
}

function fromISTtoUtc(istDate) {
  return new Date(istDate.getTime() - IST_OFFSET_MIN * MS_PER_MIN);
}

function yyyymmddIST(msUtc) {
  const d = toISTDate(msUtc);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/**
 * Build today's IST slots (as UTC timestamps) for n bumps per day.
 * 1 → [10:00] IST
 * 2 → [10:00, 18:00] IST
 * 3 → [09:00, 15:00, 21:00] IST
 * default (≥4) → evenly spaced over 24h
 */
function todaySlotsISTasUTC(bumpsPerDay, baseUtcMs) {
  const todayIst = toISTDate(baseUtcMs);
  const y = todayIst.getUTCFullYear();
  const m = todayIst.getUTCMonth();
  const d = todayIst.getUTCDate();

  let hh = [];
  if (bumpsPerDay <= 1) hh = [10];
  else if (bumpsPerDay === 2) hh = [10, 18];
  else if (bumpsPerDay === 3) hh = [9, 15, 21];
  else {
    // evenly spaced
    const step = 24 / bumpsPerDay;
    hh = Array.from({ length: bumpsPerDay }, (_, i) => Math.floor(i * step));
  }

  const istDates = hh.map(H => new Date(Date.UTC(y, m, d, H, 0, 0, 0)));
  // convert IST → UTC: we stored them as UTC using UTC ctor, but the "hours" above are IST.
  // The line above creates date in UTC timezone; we need to subtract IST offset to get the real UTC instant.
  // Easiest: create a real IST date then convert back.
  const fixedUtc = istDates.map(dtUTCAsISTClock => {
    // interpret dtUTCAsISTClock as IST clock and convert to true UTC instant
    const istClock = new Date(
      Date.UTC(y, m, d, dtUTCAsISTClock.getUTCHours(), 0, 0, 0)
    );
    return fromISTtoUtc(istClock).getTime();
  });
  return fixedUtc.sort((a, b) => a - b);
}

/**
 * Given current UTC time, bumpsPerDay, bumpsDoneToday, decide the next slot (UTC ms) and whether counters should reset.
 */
function computeNextBumpUTC(nowMsUtc, bumpsPerDay, bumpsDoneToday) {
  const slots = todaySlotsISTasUTC(bumpsPerDay, nowMsUtc);
  // if still have slots left today, pick the next one in the future
  const nextToday = slots.find(t => t > nowMsUtc);
  if (nextToday && bumpsDoneToday < bumpsPerDay) {
    return { nextAt: nextToday, resetToday: false };
  }
  // otherwise first slot tomorrow
  const tomorrowUtc = nowMsUtc + MS_PER_DAY;
  const firstTomorrow = todaySlotsISTasUTC(bumpsPerDay, tomorrowUtc)[0];
  return { nextAt: firstTomorrow, resetToday: true };
}

/**
 * Check if endAt has passed.
 */
function isExpired(endAt) {
  const endMs =
    endAt?.toMillis?.() ??
    (typeof endAt === "number" ? endAt : new Date(endAt).getTime());
  return !endMs || endMs <= Date.now();
}

/**
 * Main handler
 */
export async function handler(event, context) {
  const db = getFirestore();

  const now = nowUtc();
  const nowMs = now.getTime();
  const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);
  const todayStr = yyyymmddIST(nowMs);

  const stats = {
    scanned: 0,
    due: 0,
    bumped: 0,
    deactivated: 0,
    resetOnly: 0,
    errors: 0,
  };

  try {
    // 1) Deactivate any expired boosts (safety)
    const expSnap = await db
      .collection("items")
      .where("boost.active", "==", true)
      .where("boost.endAt", "<=", nowTs)
      .limit(500)
      .get();

    if (!expSnap.empty) {
      const batch = db.batch();
      expSnap.docs.forEach(doc => {
        batch.update(doc.ref, {
          "boost.active": false,
          "boost.nextBumpAt": null,
        });
        stats.deactivated++;
      });
      await batch.commit();
    }

    // 2) Reset day counters for items where day changed (IST)
    // Firestore supports "!=" query. We reset for any that has a stored day not equal to today.
    const resetSnap = await db
      .collection("items")
      .where("boost.active", "==", true)
      .where("boost.endAt", ">", nowTs)
      .where("boost.day", "!=", todayStr)
      .limit(500)
      .get();

    if (!resetSnap.empty) {
      const batch = db.batch();
      resetSnap.docs.forEach(doc => {
        const d = doc.data();
        const b = d.boost || {};
        const perDay = Number(b.bumpsPerDay || 0);
        // compute fresh next slot for today in IST
        const next = computeNextBumpUTC(nowMs, perDay, 0).nextAt;
        batch.update(doc.ref, {
          "boost.bumpsDoneToday": 0,
          "boost.day": todayStr,
          // do not touch lastBumpedAt/priorityScore here
          "boost.nextBumpAt": next ? admin.firestore.Timestamp.fromMillis(next) : null,
        });
        stats.resetOnly++;
      });
      await batch.commit();
    }

    // 3) Pick items that are due to bump now (nextBumpAt <= now)
    const dueSnap = await db
      .collection("items")
      .where("boost.active", "==", true)
      .where("boost.endAt", ">", nowTs)
      .where("boost.nextBumpAt", "<=", nowTs)
      .limit(450) // stay safe for one batch
      .get();

    stats.scanned = dueSnap.size;
    if (dueSnap.empty) {
      return ok({ message: "No items due", stats });
    }

    const batch = db.batch();

    dueSnap.docs.forEach(doc => {
      try {
        const d = doc.data() || {};
        const b = d.boost || {};
        const perDay = Number(b.bumpsPerDay || 0);
        const doneToday = Number(b.bumpsDoneToday || 0);

        // guard
        if (perDay <= 0) {
          // nothing to do
          const { nextAt } = computeNextBumpUTC(nowMs, 1, 0); // push to tomorrow 10:00 IST
          batch.update(doc.ref, {
            "boost.nextBumpAt": nextAt
              ? admin.firestore.Timestamp.fromMillis(nextAt)
              : null,
            "boost.day": todayStr,
          });
          return;
        }

        // daily rollover handled above; ensure day tag is today
        let newDone = doneToday;
        if ((b.day || "") !== todayStr) newDone = 0;

        // If already exhausted today, schedule tomorrow first slot
        if (newDone >= perDay) {
          const { nextAt } = computeNextBumpUTC(nowMs, perDay, newDone);
          batch.update(doc.ref, {
            "boost.nextBumpAt": nextAt
              ? admin.firestore.Timestamp.fromMillis(nextAt)
              : null,
            "boost.day": todayStr,
          });
          return;
        }

        // ►► BUMP ◄◄
        const newPriority = Date.now();
        const { nextAt } = computeNextBumpUTC(nowMs, perDay, newDone + 1);

        batch.update(doc.ref, {
          priorityScore: newPriority,
          "boost.lastBumpedAt": nowTs,
          "boost.bumpsDoneToday": newDone + 1,
          "boost.nextBumpAt": nextAt
            ? admin.firestore.Timestamp.fromMillis(nextAt)
            : null,
          "boost.day": todayStr,
        });

        stats.due++;
        stats.bumped++;
      } catch (e) {
        stats.errors++;
        console.error("Error preparing bump for", doc.id, e);
      }
    });

    await batch.commit();
    return ok({ message: "Autobump run complete", stats });
  } catch (err) {
    console.error("autobump error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "autobump failed", details: String(err), stats }),
    };
  }
}

function ok(payload) {
  return { statusCode: 200, body: JSON.stringify(payload) };
}
