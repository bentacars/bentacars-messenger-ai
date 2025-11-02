// api/webhook.js
export const config = { runtime: "nodejs" };

import fetch from "node-fetch";

// ---- Env ----
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Use env WORKFLOW_ID if present; otherwise hard-fallback to the ID you gave me.
const WORKFLOW_ID =
  process.env.WORKFLOW_ID ||
  "wf_6903132fe2ac8190bd0cf21dbb1420c30aa1dfd0791000f9";

// Optional pin; omit to hit production alias in Agent Builder.
const WORKFLOW_VERSION = process.env.WORKFLOW_VERSION; // e.g. "1"

// --- tiny de-dupe to avoid loops from FB retries
const seen = new Set();
function dedupe(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return false;
}

// --- FB helpers
async function fbSendText(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_TOKEN}`;
  const payload = {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: { text },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.text();
  console.log("FB SEND:", data);
}

// ---- OpenAI Workflows v2: create run
async function createWorkflowRun(inputText) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing");
  if (!WORKFLOW_ID) throw new Error("WORKFLOW_ID missing");

  const url = `https://api.openai.com/v1/workflows/${WORKFLOW_ID}/runs`; // << correct URL
  const body = {
    inputs: { input_as_text: inputText }, // must match your Workflow input name
  };
  if (WORKFLOW_VERSION) body.version = WORKFLOW_VERSION; // optional

  console.log("Posting to:", url);
  console.log("Has Beta header:", true);
  console.log("Has key:", !!OPENAI_KEY);
  console.log("Has WORKFLOW_ID:", !!WORKFLOW_ID, WORKFLOW_ID);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "workflows=v2", // << REQUIRED
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log("WF HTTP", res.status, text);

  if (!res.ok) {
    const err = new Error(`Workflow v2 HTTP error: ${res.status}`);
    err.details = text;
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ---- Vercel handler
export default async function handler(req, res) {
  try {
    // 1) GET: webhook verification (Meta)
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send("Forbidden");
    }

    // 2) POST: incoming messages
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const body = req.body || {};
    const entry = (body.entry && body.entry[0]) || {};
    const messaging = (entry.messaging && entry.messaging[0]) || {};
    const senderId = messaging.sender && messaging.sender.id;
    const messageId = messaging.message && messaging.message.mid;
    const userText =
      (messaging.message && messaging.message.text) ||
      (messaging.postback && messaging.postback.title) ||
      "";

    console.log("Incoming:", {
      senderId,
      messageId,
      text: userText,
    });

    // ignore duplicates/retries
    if (dedupe(messageId)) {
      return res.status(200).send("OK");
    }

    // Basic guardrails
    if (!senderId) {
      return res.status(200).send("No sender");
    }
    if (!userText) {
      await fbSendText(
        senderId,
        "Hi! 😊 Pakitype ulit po in your own words so I can assist."
      );
      return res.status(200).send("OK");
    }

    // 3) Fire the workflow run (async)
    try {
      const run = await createWorkflowRun(userText);
      console.log("Run created:", run);

      // Friendly ack to user while the run processes (your workflow can message back later if you wire it)
      await fbSendText(
        senderId,
        "Salamat! Iche-check ko ang best options based sa gusto ninyo ⏳"
      );
    } catch (err) {
      console.error("WF create error:", err && err.details ? err.details : err);
      await fbSendText(
        senderId,
        "Medyo nagka-issue sa processing. Paki-try ulit or ibang wording 🙏"
      );
    }

    return res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    return res.status(200).send("OK");
  }
}
