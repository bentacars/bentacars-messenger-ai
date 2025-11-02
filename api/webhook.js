// /api/webhook.js
export const config = { runtime: "nodejs" };

import fetch from "node-fetch";
import { runAgents } from "./agent.js";   // ✅ correct path

//
//  Env
//
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;      // from Meta App
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;    // your verify token

//  Simple de-dupe to avoid loops
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

//  FB send helper
async function fbSendText(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_TOKEN}`;
  const body = {
    recipient: { id: recipientId },
    message: { text },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log("✅ FB SEND:", JSON.stringify(json));
  return json;
}

export default async function handler(req, res) {
  // === Meta Webhook Verify ===
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send("Verification failed");
    }
  }

  // === Incoming Messenger Webhooks ===
  if (req.method === "POST") {
    try {
      const entry = req.body.entry?.[0];
      const messaging = entry?.messaging?.[0];
      const senderId = messaging?.sender?.id;
      const messageId = messaging?.message?.mid;
      const text = messaging?.message?.text;

      if (!senderId || !text) {
        return res.status(200).end();
      }
      if (alreadyHandled(messageId)) {
        console.log("⏭️ Duplicate, skipping");
        return res.status(200).end();
      }

      console.log("📥 Incoming:", { senderId, messageId, text });

      // === AI reply ===
      const aiReply = await runAgents(text); // ✅ calls agent.js

      await fbSendText(senderId, aiReply.text);
      return res.status(200).end();
    } catch (err) {
      console.error("❌ WEBHOOK ERROR:", err);
      return res.status(500).send("Webhook error");
    }
  }

  return res.status(405).send("Method not allowed");
}
