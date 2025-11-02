// api/webhook.js
// Vercel Node runtime
export const config = { runtime: "nodejs" };

console.log("🔥 WEBHOOK LOADED - NEW BUILD - " + new Date().toISOString());

import OpenAI from "openai";
import fetch from "node-fetch";

/* ----------------- ENV ----------------- */
const PAGE_TOKEN   = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const WORKFLOW_ID  = process.env.WORKFLOW_ID;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

/* ---------- OpenAI client (Workflows v2) ---------- */
const openai = new OpenAI({
  apiKey: OPENAI_KEY,
  // Tell the SDK to use Workflows v2 for all workflow calls.
  defaultHeaders: { "OpenAI-Beta": "workflows=v2" },
});

/* --------- simple in-memory de-dupe (stop loops) --------- */
const seenMessageIds = new Set();
function alreadyHandled(messageId) {
  if (!messageId) return false;
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.add(messageId);
  // keep set small
  if (seenMessageIds.size > 5000) {
    const first = seenMessageIds.values().next().value;
    seenMessageIds.delete(first);
  }
  return false;
}

/* ---------------- FB send helper ---------------- */
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

/* ---------- Tiny intent detector (to decide when to run the workflow) ---------- */
const USED_CAR_REGEX =
  /\b(buy|looking|hanap|bili|kuha|used\s*car|second[-\s]?hand|preowned|mirage|vios|fortuner|innova|civic|city|avanza|pickup|mpv|van|suv|sedan|sangla|orcr|financ(?:e|ing)|loan|dp|down\s*payment)\b/i;

/* ----------------- Concierge welcome (LLM chat) ----------------- */
async function getWelcomeReply(userText) {
  try {
    const chat = await openai.chat.completions.create({
      model: OPENAI_MODEL,
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
      "Hi! Kamusta? Paano kita matutulungan today—used cars, financing, o sangla?"
    );
  } catch (err) {
    console.error("❌ OpenAI chat error:", err);
    return "Hi! Kamusta? Paano kita matutulungan today—used cars, financing, o sangla?";
  }
}

/* --------------- Call the Agent Builder workflow (v2) --------------- */
async function runWorkflowV2(inputText) {
  if (!WORKFLOW_ID) {
    console.error("❌ WORKFLOW_ID env is missing");
    return "Medyo nagka-issue sa config namin. Paki-try ulit in a moment. 🙏";
  }

  try {
    // Guard: make sure the SDK actually has workflows (prevents “runs of undefined”)
    if (!openai.workflows || !openai.workflows.runs) {
      console.error("❌ SDK doesn't expose workflows.runs — check openai package version.");
      return "Medyo nagka-issue sa processing. Paki-try ulit in a moment. 🙏";
    }

    // Create a run on your Workflow (production by default)
    const run = await openai.workflows.runs.create({
      workflow_id: WORKFLOW_ID,
      input: { input_as_text: inputText },
      // You can send a specific version string if you want (e.g., "1" or "2"),
      // but if you're on production, omitting it will use the current production snapshot.
      // version: "2",
    });

    // Try common output shapes from Agent Builder
    const out0 = run?.output?.[0];
    const c0 = out0?.content?.[0];

    // 1) output_text / text
    const text =
      (c0?.type === "output_text" && c0?.text) ||
      (c0?.type === "text" && c0?.text) ||
      null;
    if (typeof text === "string" && text.trim()) return text.trim();

    // 2) JSON payload with message
    const maybeMsg = out0?.content?.find?.((c) => c?.type === "json")?.json?.message;
    if (typeof maybeMsg === "string" && maybeMsg.trim()) return maybeMsg.trim();

    console.warn("⚠️ Unrecognized workflow output shape:", JSON.stringify(run).slice(0, 800));
    return "Salamat! Iche-check ko ang best options para sa’yo ngayon. 🚗";
  } catch (err) {
    // If anything fails we NEVER throw — we return a soft message to avoid messenger errors
    console.error("❌ Workflow v2 call failed:", err);
    return "Medyo nagka-issue sa processing. Paki-try ulit in a moment. 🙏";
  }
}

/* ------------------------------ Main handler ------------------------------ */
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      // Facebook webhook verification
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verify OK");
        res.status(200).send(challenge);
      } else {
        console.warn("❌ Webhook verify failed");
        res.status(403).send("Forbidden");
      }
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    // Facebook may POST stringified JSON depending on settings
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (!payload?.entry?.length) {
      res.status(200).send("EVENT_RECEIVED");
      return;
    }

    for (const entry of payload.entry) {
      const messagings = entry?.messaging || [];
      for (const m of messagings) {
        // Skip echoes (messages sent by our page)
        if (m?.message?.is_echo) continue;

        const senderId = m?.sender?.id;
        const text = m?.message?.text?.trim();
        const mid = m?.message?.mid;

        if (!senderId || !text) continue;
        if (alreadyHandled(mid)) {
          console.log("🟡 Duplicate message ignored:", mid);
          continue;
        }

        console.log("🟢 Incoming:", { senderId, messageId: mid, text });

        // First reply: short concierge
        const welcome = await getWelcomeReply(text);
        await fbSendText(senderId, welcome);

        // If intent looks like used-car flow, call your Workflow v2
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

    // FB requires 200 quickly even if we hit errors
    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("❌ Webhook fatal error:", err);
    // Never fail for Messenger
    res.status(200).send("EVENT_RECEIVED");
  }
}
