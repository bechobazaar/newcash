// netlify/functions/_mail.js
import nodemailer from "nodemailer";

let transporter;

function getMailer() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP env missing (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS)");
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // 465 -> SSL, 587 -> STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  return transporter;
}

export async function sendAckMail({ to, ticketId, subject, status = "Open", chatUrl }) {
  const brand = process.env.BRAND_NAME || "Bechobazaar Support";
  const from = process.env.FROM_EMAIL || `"${brand}" <no-reply@bechobazaar.app>`;
  const replyTo = process.env.SUPPORT_REPLY_TO || from;
  const shortId = String(ticketId).replace(/^BB-?/,"").slice(0,8).toUpperCase();

  const text = [
    "Namaste!",
    "",
    "Aapka support ticket register ho gaya hai.",
    `Ticket ID: ${ticketId}`,
    `Subject: ${subject || "(none)"}`,
    "",
    `Status/Chat: ${chatUrl}`,
    "",
    `– ${brand}`
  ].join("\n");

  const html = `
  <div style="font-family:system-ui,Segoe UI,Arial,sans-serif">
    <h2 style="margin:0 0 8px">${brand}</h2>
    <p style="margin:0 0 12px;color:#111">Aapka support ticket register ho gaya hai.</p>
    <table style="border-collapse:collapse;border:1px solid #eee">
      <tr><td style="padding:8px;border:1px solid #eee"><b>Ticket ID</b></td><td style="padding:8px;border:1px solid #eee">${ticketId}</td></tr>
      <tr><td style="padding:8px;border:1px solid #eee"><b>Subject</b></td><td style="padding:8px;border:1px solid #eee">${subject || ""}</td></tr>
      <tr><td style="padding:8px;border:1px solid #eee"><b>Status</b></td><td style="padding:8px;border:1px solid #eee">${status}</td></tr>
    </table>
    <p style="margin:16px 0">Continue chat / status: <a href="${chatUrl}">${chatUrl}</a></p>
    <p style="color:#666;font-size:12px;margin-top:20px">Is email ka reply karke bhi aap hume likh sakte hain.</p>
  </div>`;

  const mail = {
    from,
    to,
    subject: `[#${shortId}] Ticket received: ${subject || "Support request"}`,
    text,
    html,
    replyTo,
    headers: { "X-Ticket-Id": ticketId }
  };
  if (process.env.SUPPORT_BCC) mail.bcc = process.env.SUPPORT_BCC;

  await getMailer().sendMail(mail);
}
