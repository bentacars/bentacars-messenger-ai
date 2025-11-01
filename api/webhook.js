// api/webhook.js
// Vercel — Node runtime
export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import fetch from "node-fetch"; // Vercel Node has fetch, but keeping import for local dev

// --- Env ---
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || "";
const WORKFLOW_ID = process.env.WORKFLOW_ID;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

// --- OpenAI client (SDK handles API versioning; no /v1 vs /v2 mistakes) ---
const openai = new OpenAI({
  apiKey: OPENAI_KEY,
  ...(OPENAI_PROJECT ? { project: OPENAI_PROJECT } : {}),
});

// --- FB send helper ---
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

  const data = await res.text(); // keep raw for logging
  if (!res.ok) {
    console.error("❌ FB SEND error:", res.status, data);
    return { ok: false, status: res.status, data };
  }
  console.log("✅ FB SEND:", data);
  return { ok: true };
}

// --- Simple intent detector (Taglish + common model names) ---
const USED_CAR_REGEX =
  /\b(buy|looking|hanap|bili|kuha|used\s*car|second[-\s]?hand|preowned|mirage|vios|fortuner|innova|civic|city|crosswind|avanza|sangla|orcr|financ(?:e|ing)|loan|dp|downpayment|down\s*payment)\b/i;

// --- Welcome chat (normal LLM reply) ---
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
        {
          role: "user",
          content: userText || "Hi",
        },
      ],
    });

    const reply =
      chat?.choices?.[0]?.message?.content?.trim() ||
      "Hi po! Welcome to BentaCars 😊 Interested po ba kayo sa used car options or need ninyo ng tulong sa financing?";
    return reply;
  } catch (err) {
    console.error("❌ OpenAI chat error:", err);
    return "Hi! Welcome to BentaCars 😊 How can we help you today?";
  }
}

// --- Trigger Agent Builder Workflow (via SDK beta.workflows) ---
async function runWorkflowV2(inputText) {
  if (!WORKFLOW_ID) throw new Error("WORKFLOW_ID env is missing");

  try {
    // SDK abstracts the path; no manual '/v1' or '/v2' URL strings here.
    const run = await openai.beta.workflows.runs.create({
      workflow_id: WORKFLOW_ID,
      input: { input_as_text: inputText },
    });

    // The output shape depends on your workflow; we’ll try common shapes:
    // 1) Single text output
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

    // 2) If your workflow returns a JSON object with { message }
    const maybeMsg = out0?.content?.find?.((c) => c?.type === "json")?.json
      ?.message;
    if (typeof maybeMsg === "string" && maybeMsg.trim()) {
      return maybeMsg.trim();
    }

    // Fallback: stringify a small slice for debugging
    console.warn("⚠️ Unrecognized workflow output shape:", JSON.stringify(run).slice(0, 800));
    return "Thanks! Let me check matching units for you now. 🚗";
  } catch (err) {
    // If the SDK still throws a URL/version issue, we capture it and don’t break the chat
    console.error("❌ Workflow v2 failed:", err);
    return "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏";
  }
}

// --- Main handler ---
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      // Webhook verification handshake
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

    const body = req.body || {};
    // Facebook sometimes POSTs stringified JSON depending on config
    const payload = typeof body === "string" ? JSON.parse(body) : body;

    // Basic structure guard
    if (!payload?.entry?.length) {
      console.warn("⚠️ No entries in webhook payload");
      res.status(200).send("EVENT_RECEIVED");
      return;
    }

    for (const entry of payload.entry) {
      const messagings = entry?.messaging || [];
      for (const m of messagings) {
        const senderId = m?.sender?.id;
        const text = m?.message?.text?.trim();

        if (!senderId || !text) {
          continue;
        }

        console.log("🟢 Incoming:", { senderId, text });

        // 1) Always send a quick welcome/concierge reply first
        const welcome = await getWelcomeReply(text);
        await fbSendText(senderId, welcome);

        // 2) If message indicates used-car intent → trigger your workflow v2
        if (USED_CAR_REGEX.test(text)) {
          const thinkingNote = "Salamat! Iche-check ko muna ang available options based sa gusto ninyo. ⏳";
          await fbSendText(senderId, thinkingNote);

          const wfReply = await runWorkflowV2(text);
          await fbSendText(senderId, wfReply);
        }
      }
    }

    // FB requires 200 quickly
    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("❌ Webhook fatal error:", err);
    // Never fail the webhook for FB; reply 200 with a soft notice
    res.status(200).send("EVENT_RECEIVED");
  }
}
