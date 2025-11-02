// api/webhook.js
export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import fetch from "node-fetch";

// ─── Env ───────────────────────────────────────────────────────────────────────
const PAGE_TOKEN   = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;   // set in Vercel
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || "";
const WORKFLOW_ID    = process.env.WORKFLOW_ID;      // wf_...

// ─── OpenAI client (Workflows v2 header) ──────────────────────────────────────
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  ...(OPENAI_PROJECT ? { project: OPENAI_PROJECT } : {}),
  defaultHeaders: { "OpenAI-Beta": "workflows=v2" }
});

// Debug banner
console.log("🔥 WEBHOOK LOADED - NEW BUILD -", new Date().toISOString());
console.log(
  "Has workflows API? =",
  !!(openai.workflows?.runs || openai.beta?.workflows?.runs)
);

// choose the right namespace (stable vs beta)
function getWorkflowClient() {
  if (openai.workflows?.runs?.create) return openai.workflows;
  if (openai.beta?.workflows?.runs?.create) return openai.beta.workflows;
  throw new Error("OpenAI SDK does not expose workflows.runs on this version");
}

// ─── De-dupe incoming FB messages ────────────────────────────────────────────
const seenMessageIds = new Set();
function alreadyHandled(messageId) {
  if (!messageId) return false;
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.add(messageId);
  if (seenMessageIds.size > 5000) {
    const first = seenMessageIds.values().next().value;
    seenMessageIds.delete(first);
  }
  return false;
}

// ─── FB helper ────────────────────────────────────────────────────────────────
async function fbSendText(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(
    PAGE_TOKEN
  )}`;
  const body = {
    recipient: { id: recipientId },
    message: { text },
    messaging_type: "RESPONSE",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.text();
  if (!res.ok) {
    console.error("❌ FB SEND error:", res.status, data);
    return { ok: false, status: res.status, data };
  }
  console.log("✅ FB SEND:", data);
  return { ok: true };
}

// ─── Light intent + quick concierge reply ─────────────────────────────────────
const USED_CAR_REGEX =
  /\b(buy|looking|hanap|bili|kuha|used\s*car|second[-\s]?hand|preowned|mirage|vios|fortuner|innova|civic|city|crosswind|avanza|sangla|orcr|financ(?:e|ing)|loan|dp|downpayment|down\s*payment)\b/i;

async function getWelcomeReply(userText) {
  try {
    const chat = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are BentaCars Concierge. Be brief, friendly, Taglish, and helpful. If the user asks about used cars/financing/sangla, invite them to share body type and city.",
        },
        { role: "user", content: userText || "Hi" },
      ],
    });
    return (
      chat?.choices?.[0]?.message?.content?.trim() ||
      "Hi po! Welcome to BentaCars 😊 Interested po ba kayo sa used car options or tulong sa financing?"
    );
  } catch (err) {
    console.error("❌ OpenAI chat error:", err);
    return "Hi! Welcome to BentaCars 😊 How can we help you today?";
  }
}

// ─── Run Workflows v2, safely ────────────────────────────────────────────────
async function runWorkflowV2(inputText) {
  if (!WORKFLOW_ID) throw new Error("WORKFLOW_ID env is missing");
  const wf = getWorkflowClient();

  try {
    const run = await wf.runs.create({
      workflow_id: WORKFLOW_ID,
      input: { input_as_text: inputText },
      // version: "1", // uncomment to force a specific workflow version
    });

    const out0 = run?.output?.[0];
    const content0 = out0?.content?.[0];

    const maybeText =
      content0?.type === "output_text"
        ? content0?.text
        : content0?.type === "text"
        ? content0?.text
        : null;

    if (typeof maybeText === "string" && maybeText.trim()) {
      return maybeText.trim();
    }

    const maybeMsg = out0?.content?.find?.((c) => c?.type === "json")?.json
      ?.message;
    if (typeof maybeMsg === "string" && maybeMsg.trim()) {
      return maybeMsg.trim();
    }

    console.warn("⚠️ Unrecognized workflow output shape");
    return "Thanks! Let me check matching units for you now. 🚗";
  } catch (err) {
    console.error("❌ Workflow v2 failed:", err);
    return "Medyo nagka-issue sa processing. Paki-try ulit or rephrase ng kaunti. 🙏";
  }
}

// ─── Main webhook ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    // Verify webhook (GET)
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verify: success");
        res.status(200).send(challenge);
      } else {
        console.warn("❌ Webhook verify: failed");
        res.status(403).send("Forbidden");
      }
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!payload?.entry?.length) {
      console.warn("⚠️ No entries in payload");
      res.status(200).send("EVENT_RECEIVED");
      return;
    }

    for (const entry of payload.entry) {
      const messagings = entry?.messaging || [];
      for (const m of messagings) {
        const senderId = m?.sender?.id;
        const text = m?.message?.text?.trim();
        const messageId = m?.message?.mid;
        if (!senderId || !text) continue;
        if (alreadyHandled(messageId)) continue;

        console.log("🟢 Incoming:", { senderId, messageId, text });

        const welcome = await getWelcomeReply(text);
        await fbSendText(senderId, welcome);

        if (USED_CAR_REGEX.test(text)) {
          await fbSendText(
            senderId,
            "Sige po, iche-check ko ang available options based sa gusto ninyo. ⏳"
          );
          const wfReply = await runWorkflowV2(text);
          await fbSendText(senderId, wfReply);
        }
      }
    }

    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("❌ Webhook fatal error:", err);
    res.status(200).send("EVENT_RECEIVED"); // prevent FB retries
  }
}
