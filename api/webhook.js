// api/webhook.js
// Vercel serverless function (ESM). Handles FB Messenger → OpenAI Agents Workflow v2.
export const config = { runtime: "nodejs" };

import OpenAI from "openai";

// ---------- ENV ----------
const PAGE_TOKEN        = process.env.PAGE_ACCESS_TOKEN;      // Facebook Page Access Token
const VERIFY_TOKEN      = process.env.META_VERIFY_TOKEN;       // Webhook verify token
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;          // sk-proj-...
const WORKFLOW_ID       = process.env.WORKFLOW_ID;             // wf_...
const WORKFLOW_VERSION  = process.env.WORKFLOW_VERSION || "";  // optional: "2" to pin v2, else use production

// ---------- GUARDS ----------
if (!PAGE_TOKEN)   console.warn("⚠️ Missing PAGE_ACCESS_TOKEN");
if (!VERIFY_TOKEN) console.warn("⚠️ Missing META_VERIFY_TOKEN");
if (!OPENAI_API_KEY) console.warn("⚠️ Missing OPENAI_API_KEY");
if (!WORKFLOW_ID)  console.warn("⚠️ Missing WORKFLOW_ID");

// ---------- OPENAI SDK ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- HELPERS ----------
async function fbSendText(recipientId, text) {
  const url =
    `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;

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

  const raw = await res.text(); // keep raw for logs
  if (!res.ok) {
    console.error("❌ FB SEND", res.status, raw);
    return { ok: false, status: res.status, raw };
  }
  console.log("✅ FB SEND:", raw);
  return { ok: true };
}

// Taglish intent keywords to decide when to invoke the workflow
const USED_CAR_REGEX =
  /\b(buy|looking|hanap|bili|kuha|used\s*car|second[-\s]?hand|preowned|mirage|vios|fortuner|innova|civic|city|avanza|sangla|orcr|financ(?:e|ing)|loan|dp|down\s*payment|downpayment|budget|sedan|suv|mpv|hatchback|van|pickup)\b/i;

// quick welcome reply driven by a small chat completion
async function getWelcomeReply(userText) {
  try {
    const chat = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are BentaCars Concierge. Be brief, warm, and Taglish. If they ask about used cars/financing/sangla, invite them to share body type and city.",
        },
        { role: "user", content: userText || "Hi" },
      ],
    });
    return (
      chat?.choices?.[0]?.message?.content?.trim() ||
      "Hi po! 😊 Welcome to BentaCars. Interested po ba kayo sa used-car options or need ninyo ng tulong sa financing?"
    );
  } catch (e) {
    console.error("❌ OpenAI chat error:", e);
    return "Hi po! 😊 Welcome to BentaCars. How can we help you today?";
  }
}

// Run Agents Workflow v2 via SDK
async function runWorkflowV2(inputText) {
  if (!WORKFLOW_ID) throw new Error("WORKFLOW_ID env is missing");

  try {
    // The SDK abstracts REST details. No manual /v1 vs /v2 URLs needed.
    const args = {
      workflow_id: WORKFLOW_ID,
      input: { input_as_text: inputText },
    };
    if (WORKFLOW_VERSION) args.version = WORKFLOW_VERSION; // e.g., "2" to pin v2

    const run = await openai.beta.workflows.runs.create(args);

    // Try common shapes to extract a user-facing message
    const firstOut = run?.output?.[0];
    const content0 = firstOut?.content?.[0];

    if (content0?.type === "output_text" && content0?.text) {
      return content0.text.trim();
    }
    if (content0?.type === "text" && content0?.text) {
      return content0.text.trim();
    }

    // JSON fallback: look for { message: "..." }
    const jsonBlock = firstOut?.content?.find?.((c) => c?.type === "json");
    const msgFromJson = jsonBlock?.json?.message;
    if (typeof msgFromJson === "string" && msgFromJson.trim()) {
      return msgFromJson.trim();
    }

    console.warn("⚠️ Unrecognized workflow output shape:", JSON.stringify(run).slice(0, 800));
    return "Thanks! Iche-check ko ang best matches para sa inyo. 🚗";
  } catch (e) {
    console.error("❌ Workflow v2 failed:", e);
    return "Medyo nagka-issue sa processing. Paki-try ulit in a moment. 🙏";
  }
}

// In-memory dedupe per invocation (prevents echo/duplicate within same request)
const seenMessageIds = new Set();

// ---------- MAIN HANDLER ----------
export default async function handler(req, res) {
  try {
    // FB webhook verification
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verify success");
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

    // Facebook may POST a string; normalize to object
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (!payload?.entry?.length) {
      console.warn("⚠️ No entries in webhook payload");
      res.status(200).send("EVENT_RECEIVED");
      return;
    }

    for (const entry of payload.entry) {
      const events = entry.messaging || [];
      for (const m of events) {
        // Skip echoes (messages we sent)
        if (m?.message?.is_echo) continue;

        const senderId = m?.sender?.id;
        const mid = m?.message?.mid;
        const text = m?.message?.text?.trim();

        if (!senderId || !mid || !text) continue;
        if (seenMessageIds.has(mid)) {
          console.log("🟨 Duplicate message skipped:", mid);
          continue;
        }
        seenMessageIds.add(mid);

        console.log("🟢 Incoming:", { senderId, text });

        // 1) Send a concierge reply right away
        const welcome = await getWelcomeReply(text);
        await fbSendText(senderId, welcome);

        // 2) If user intent looks like used-car inquiry → run workflow
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

    // Acknowledge to FB quickly
    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("❌ Webhook fatal error:", err);
    // Never let FB retry storm; still 200
    res.status(200).send("EVENT_RECEIVED");
  }
}
