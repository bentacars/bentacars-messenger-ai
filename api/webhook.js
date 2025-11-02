// /api/webhook.js
export const config = { runtime: "nodejs" };

import fetch from "node-fetch";
import { runAgents } from "../agents.js";

/**
 * Env
 */
const PAGE_TOKEN   = process.env.PAGE_ACCESS_TOKEN;   // from Meta App
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;   // your verify token

// Simple de-dupe to avoid loops
const seenMessageIds = new Set();
function alreadyHandled(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  if (seenMessageIds.size > 5000) {
    const first = seenMessageIds.values().next().value;
    seenMessageIds.delete(first);
  }
  return false;
}

// FB send helper
async function fbSendText(psid, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const body = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { text: text || " " },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  console.log("✅ FB SEND:", JSON.stringify(j));
  return j;
}

export default async function handler(req, res) {
  // GET: verify
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ WEBHOOK VERIFIED");
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // POST: incoming
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const body = req.body || {};
    const entry = body.entry?.[0];
    const messaging = entry?.messaging?.[0];
    const messageId = messaging?.message?.mid;
    const senderId = messaging?.sender?.id;
    const text = messaging?.message?.text ?? "";

    // log a banner each fresh boot
    if (process.env.__WEBHOOK_BOOT_LOGGED !== "1") {
      console.log(`🔥 WEBHOOK LOADED - NEW BUILD - ${new Date().toISOString()}`);
      process.env.__WEBHOOK_BOOT_LOGGED = "1";
    }

    if (!senderId) {
      return res.status(200).json({ ok: true, skipped: "no sender" });
    }
    if (alreadyHandled(messageId)) {
      return res.status(200).json({ ok: true, skipped: "duplicate" });
    }

    console.log("📥 Incoming:", { senderId, messageId, text });

    // Typing indicator (optional)
    try {
      await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: senderId }, sender_action: "typing_on" }),
      });
    } catch {}

    // Run your Agents pipeline
    let reply = "Medyo nagka-issue sa processing. Paki-try ulit in a moment.";
    try {
      const result = await runAgents(text || "");
      reply = result?.text || reply;
    } catch (e) {
      console.error("❌ Agents error:", e);
    }

    await fbSendText(senderId, reply);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Webhook fatal error:", err);
    return res.status(200).json({ ok: true, error: "handled" });
  }
}
