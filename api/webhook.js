// api/webhook.js
export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import fetch from "node-fetch";

// --- Env ---
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const WORKFLOW_ID = process.env.WORKFLOW_ID;

// --- OpenAI client (SDK v4.78+ required) ---
const openai = new OpenAI({
  apiKey: OPENAI_KEY,
  // Tell SDK we're using Workflows v2 on every call
  defaultHeaders: { "OpenAI-Beta": "workflows=v2" }
});

// --- Simple, in-memory de-dupe to stop loops ---
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

// --- FB send helper ---
async function fbSendText(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(
    PAGE_TOKEN
  )}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      messaging_type: "RESPONSE"
    })
  });

  const raw = await res.text();
  if (!res.ok) console.error("❌ FB SEND error:", res.status, raw);
  else console.log("✅ FB SEND:", raw);
}

// --- Intent detector ---
const USED_CAR_REGEX =
  /\b(buy|looking|hanap|bili|kuha|used\s*car|second[-\s]?hand|preowned|mirage|vios|fortuner|innova|civic|city|avanza|sangla|orcr|financ(?:e|ing)|loan|dp|down\s*payment)\b/i;

// --- Welcome reply (light LLM) ---
async function welcomeReply(userText) {
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are BentaCars Concierge. Be brief, friendly, Taglish. If user mentions used cars/financing/sangla, invite body type + city."
        },
        { role: "user", content: userText || "Hi" }
      ]
    });
    return (
      resp?.choices?.[0]?.message?.content?.trim() ||
      "Hi po! Welcome to BentaCars 😊 Interested po ba kayo sa used car options or need ninyo ng tulong sa financing?"
    );
  } catch (e) {
    console.error("❌ chat mini error:", e);
    return "Hi po! Welcome to BentaCars 😊 How can we help you today?";
  }
}

// --- Call Agent Builder Workflow v2 via SDK ---
async function runWorkflowV2(inputText) {
  if (!WORKFLOW_ID) throw new Error("WORKFLOW_ID env is missing");
  // IMPORTANT: the SDK path is openai.workflows.runs.create with the header set in client
  const run = await openai.workflows.runs.create({
    workflow_id: WORKFLOW_ID,
    // omit version to hit production; or pass { version: "1" } to pin v1
    input: { input_as_text: inputText }
  });

  // Common output shapes
  const first = run?.output?.[0]?.content?.[0];
  if (first?.type === "output_text" && first?.text) return first.text.trim();
  if (first?.type === "text" && first?.text) return first.text.trim();

  const jsonMsg = run?.output?.[0]?.content?.find?.(c => c?.type === "json")?.json?.message;
  if (typeof jsonMsg === "string" && jsonMsg.trim()) return jsonMsg.trim();

  console.warn("⚠️ Unrecognized workflow output:", JSON.stringify(run).slice(0, 800));
  return "Thanks! Iche-check ko ang best options for you. 🚗";
}

// --- Main handler ---
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      // webhook verify
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Verified webhook");
        return res.status(200).send(challenge);
      }
      console.warn("❌ Verify failed");
      return res.status(403).send("Forbidden");
    }

    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // Messenger sometimes posts as string
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!payload?.entry?.length) {
      console.warn("⚠️ No entries");
      return res.status(200).send("EVENT_RECEIVED");
    }

    for (const entry of payload.entry) {
      const events = entry.messaging || [];
      for (const m of events) {
        const msg = m.message;
        const senderId = m?.sender?.id;
        const messageId = msg?.mid;
        const text = msg?.text?.trim();

        // LOOP GUARDS:
        if (msg?.is_echo) continue;               // ignore our own messages
        if (alreadyHandled(messageId)) continue;  // de-dupe same MID
        if (!senderId || !text) continue;

        console.log("🟢 Incoming:", { senderId, messageId, text });

        // 1) concierge reply
        const welcome = await welcomeReply(text);
        await fbSendText(senderId, welcome);

        // 2) trigger workflow if intent
        if (USED_CAR_REGEX.test(text)) {
          await fbSendText(senderId, "Sige po, iche-check ko ang available options based sa gusto ninyo. ⏳");
          try {
            const wf = await runWorkflowV2(text);
            await fbSendText(senderId, wf);
          } catch (e) {
            console.error("❌ Workflow v2 failed:", e);
            await fbSendText(senderId, "Medyo nagka-issue sa processing. Paki-try ulit in a moment. 🙏");
          }
        }
      }
    }

    res.status(200).send("EVENT_RECEIVED");
  } catch (e) {
    console.error("❌ Webhook fatal:", e);
    res.status(200).send("EVENT_RECEIVED");
  }
}
