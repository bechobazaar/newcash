// netlify/functions/notify-on-new-message.js
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const res = (statusCode, body) =>
  ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(204, {});
  try {
    const { chatId, messageId } = JSON.parse(event.body || "{}");
    if (!chatId || !messageId) return res(400, { ok:false, error: "missing params" });

    const [chatDoc, msgDoc] = await Promise.all([
      db.collection("chats").doc(chatId).get(),
      db.collection("chats").doc(chatId).collection("messages").doc(messageId).get(),
    ]);

    const chat = chatDoc.data() || {};
    const msg  = msgDoc.data() || {};
    const sender = msg.senderId;
    const users = chat.users || [];

    // 🎯 pick only receiver
    const recipient = users.find(u => u && u !== sender);
    if (!recipient) return res(200, { ok:true, skipped: "no recipient" });

    // fetch only recipient tokens
    const epsSnap = await db.collection("users").doc(recipient)
      .collection("pushEndpoints").get();

    const webTokens = [];
    epsSnap.forEach(d => {
      const e = d.data() || {};
      if (e.type === "fcm_web" && e.token) webTokens.push(e.token);
    });

    // send
    const payload = {
      notification: {
        title: "New message",
        body: (msg.text || "New message received").slice(0, 140),
        click_action: `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}`
      },
      data: { chatId }
    };

    let report = null;
    if (webTokens.length) {
      report = await admin.messaging().sendToDevice(webTokens, payload, { priority: "high" });
    }

    await db.collection("chats").doc(chatId).collection("messages").doc(messageId)
      .set({ delivered: true }, { merge: true });

    return res(200, { ok:true, result: { webTokens: webTokens.length, report }});
  } catch (e) {
    return res(500, { ok:false, error: String(e) });
  }
};
