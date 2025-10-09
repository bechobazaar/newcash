// (B) Chat message -> notify only the receiver (Appilix direct)
// Body: { chatId, messageId, receiverUid, preview, open }
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let app;
function init() {
  if (!app) {
    const { FIREBASE_SERVICE_ACCOUNT_B64, FIREBASE_PROJECT_ID } = process.env;
    if (!FIREBASE_SERVICE_ACCOUNT_B64 || !FIREBASE_PROJECT_ID) throw new Error("Missing Firebase env");
    const json = JSON.parse(Buffer.from(FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8"));
    app = initializeApp({ credential: cert(json), projectId: FIREBASE_PROJECT_ID });
  }
  return getFirestore();
}

const directEndpoint = "/.netlify/functions/send-appilix-direct";

export const handler = async (event, ctx) => {
  try {
    const db = init();

    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type,Authorization" },
      };
    }

    const { chatId, messageId, receiverUid, preview, open } = JSON.parse(event.body || "{}");
    if (!chatId || !messageId || !receiverUid) {
      return { statusCode: 400, body: "chatId, messageId, receiverUid required" };
    }

    // (Optional) sanity: confirm message & chat exist
    const chatRef = db.collection("chats").doc(chatId);
    const msgRef = chatRef.collection("messages").doc(messageId);
    const [chatSnap, msgSnap] = await Promise.all([chatRef.get(), msgRef.get()]);
    if (!chatSnap.exists || !msgSnap.exists) {
      return { statusCode: 404, body: "chat/message not found" };
    }

    // Build title/body/link
    const title = "New message";
    const body = (preview && String(preview).slice(0, 90)) || "You received a new message";
    const open_link_url =
      open ||
      `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}&m=${encodeURIComponent(
        messageId
      )}`;

    // Call local direct function (keeps single code path for Appilix)
    const res = await fetch(directEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, user_identity: receiverUid, open_link_url }),
    });

    const text = await res.text();
    return { statusCode: 200, body: text };
  } catch (e) {
    return { statusCode: 500, body: e.message };
  }
};
