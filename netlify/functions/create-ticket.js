// netlify/functions/create-ticket.js
import { getAdmin, corsHeaders, corsPreflight } from "./_admin.js";
import { sendAckMail } from "./_mail.js";

function pad(n){ return String(n).padStart(2,"0"); }
function genId() {
  const d = new Date();
  const rand = Math.random().toString(36).slice(2,6).toUpperCase();
  return `BB-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${rand}`;
}

export const handler = async (event) => {
  // Preflight
  const pre = corsPreflight(event);
  if (pre) return pre;

  const headers = corsHeaders(event.headers.origin || "*");

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  try {
    const { admin, db } = getAdmin();

    // Verify Firebase ID token from Authorization header
    const authz = event.headers.authorization || "";
    const idToken = (authz.startsWith("Bearer ") && authz.slice(7)) || null;
    if (!idToken) throw new Error("Missing Authorization Bearer token");

    const firebaseUser = await admin.auth().verifyIdToken(idToken);
    const uid = firebaseUser.uid;

    // Body
    const body = JSON.parse(event.body || "{}");
    const subject = String(body.subject || "").trim();
    const message = String(body.message || "").trim();
    if (!subject || !message) throw new Error("Subject and message required");

    const category = String(body.category || "Account related issue");
    const priority = String(body.priority || "Normal");
    const userName = String(body.userName || firebaseUser.name || "User");
    const email = String(body.email || firebaseUser.email || "").trim();

    const ticketId = genId();
    const now = admin.firestore.FieldValue.serverTimestamp();

    // Root ticket
    const base = {
      id: ticketId,
      userId: uid,
      user: { name: userName, email },
      email,                       // keep a top-level copy for backend
      subject, category, priority,
      status: "Open",
      createdAt: now,
      updatedAt: now,
      lastBy: "user"
    };
    await db.collection("tickets").doc(ticketId).set(base);

    // First message
    await db.collection("tickets").doc(ticketId).collection("messages").add({
      by: "user",
      authorId: uid,
      authorName: userName,
      authorEmail: email,
      text: message,
      attachments: [],
      createdAt: now
    });

    // Send ack email (if email available)
    const chatBase = process.env.CHAT_URL_BASE || "https://bechobazaar.netlify.app/support/chat.html";
    const chatUrl = `${chatBase}?tid=${encodeURIComponent(ticketId)}`;

    if (email) {
      await sendAckMail({ to: email, ticketId, subject, status: "Open", chatUrl });
      await db.collection("tickets").doc(ticketId).set({
        emailAckAt: now,
        emailAckTo: email
      }, { merge: true });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, ticketId })
    };
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
