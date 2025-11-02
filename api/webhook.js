// api/webhook.js
// Vercel — Node runtime
export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import fetch from "node-fetch"; // ok on local; Vercel has global fetch

// --- Env ---
const PAGE_TOKEN     = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN   = process.env.META_VERIFY_TOKEN;
const OPENAI_KEY     = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || "";
const WORKFLOW_ID    = process.env.WORKFLOW_ID;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4.1";

// --- OpenAI client ---
const openai = new OpenAI({
  apiKey: OPENAI_KEY,
  ...(OPENAI_PROJECT ? { project: OPENAI_PROJECT } : {}),
});

// ---------- FB helpers ----------
async function fbSendText(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const body = { recipient: { id: recipientId }, message: { text }, messaging_type: "RESPONSE" };

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

// ---------- Simple intents ----------
const USED_CAR_REGEX =
  /\b(buy|looking|hanap|bili|kuha|used\s*car|second[-\s]?hand|preowned|mirage|vios|fortuner|innova|civic|city|crosswind|avanza|sangla|orcr|financ(?:e|ing)|loan|dp|downpayment|down\s*payment|sedan|suv|mpv|van|hatchback|pickup)\b/i;

function isGreeting(text = "") {
  const s = text.toLowerCase();
  return /\b(hi|hello|hey|kumusta|good\s*(morning|afternoon|evening)|gud\s*(am|pm))\b/.test(s);
}

// ---------- Chat welcome (only when NOT used-car intent) ----------
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
      "Hi po! Welcome to BentaCars 😊 Interested po ba kayo sa used car options or need ninyo ng tulong sa financing?"
    );
  } catch (err) {
    console.error("❌ OpenAI chat error:", err);
    return "Hi! Welcome to BentaCars 😊 How can we help you today?";
  }
}

// ---------- Trigger Agent Builder Workflow v2 (SDK) ----------
async function runWorkflowV2(inputText) {
  if (!WORKFLOW_ID) throw new Error("WORKFLOW_ID env is missing");
  try {
    const run = await openai.beta.workflows.runs.create({
      workflow_id: WORKFLOW_ID,
      input: { input_as_text: inputText },
    });

    // Try common shapes from Agent Builder
    const out0 = run?.output?.[0];
    const content0 = out0?.content?.[0];

    const asText =
      (content0?.type === "output_text" && content0?.text) ||
      (content0?.type === "text" && content0?.text) ||
      out0?.content?.find?.((c) => c?.type === "json")?.json?.message;

    if (typeof asText === "string" && asText.trim()) return asText.trim();

    console.warn("⚠️ Unrecognized workflow output shape:", JSON.stringify(run).slice(0, 800));
    return "Thanks! Let me check matching units for you now. 🚗";
  } catch (err) {
    console.error("❌ Workflow v2 failed:", err);
    return "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏";
  }
}

// ---------- LOOP GUARDS ----------
// 1) Ignore page echoes (messages our page sent)
// 2) Deduplicate by message.mid (Messenger retries). Keep 5-minute TTL.
const seenMIDs = new Map(); // mid -> timestamp
function isDuplicateMid(mid) {
  const now = Date.now();
  // cleanup old
  for (const [k, ts] of seenMIDs) {
    if (now - ts > 5 * 60 * 1000) seenMIDs.delete(k);
  }
  if (!mid) return false;
  if (seenMIDs.has(mid)) return true;
  seenMIDs.set(mid, now);
  return false;
}

// ---------- Main handler ----------
export default async function handler(req, res) {
  try {
    // Verification handshake
    if (req.method === "GET") {
      const { ["hub.mode"]: mode, ["hub.verify_token"]: token, ["hub.challenge"]: challenge } = req.query;
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verify: success");
        return res.status(200).send(challenge);
      }
      console.warn("❌ Webhook verify: failed");
      return res.status(403).send("Forbidden");
    }

    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    if (!body?.entry?.length) {
      console.warn("⚠️ No entries in webhook payload");
      return res.status(200).send("EVENT_RECEIVED");
    }

    for (const entry of body.entry) {
      const events = entry.messaging || [];
      for (const m of events) {
        const mid = m?.message?.mid;
        const isEcho = !!m?.message?.is_echo;

        // Ignore echoes (messages our page sent) → prevents ping-pong loops
        if (isEcho) {
          console.log("⏩ Ignoring echo mid:", mid);
          continue;
        }

        // Delivery/read events or non-texts
        const senderId = m?.sender?.id;
        const text = m?.message?.text?.trim();
        if (!senderId || !text) {
          continue;
        }

        // Deduplicate retries by mid
        if (isDuplicateMid(mid)) {
          console.log("⏩ Ignoring duplicate mid:", mid);
          continue;
        }

        console.log("🟢 Incoming:", { senderId, mid, text });

        const hasUsedCarIntent = USED_CAR_REGEX.test(text);

        // If it's clearly used-car intent → go straight to workflow (no extra welcome)
        if (hasUsedCarIntent) {
          await fbSendText(senderId, "Got it! Iche-check ko ang best options for you. ⏳");
          const wfReply = await runWorkflowV2(text);
          await fbSendText(senderId, wfReply);
          continue;
        }

        // Otherwise, greet/concierge reply (short, friendly)
        if (isGreeting(text)) {
          const welcome = await getWelcomeReply(text);
          await fbSendText(senderId, welcome);
        } else {
          // neutral fallback ask
          await fbSendText(
            senderId,
            "Para matulungan kita agad, sabihin lang kung anong hanap mo (e.g. “sedan sa QC”, “used car options”, “financing with 80k DP”)."
          );
        }
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("❌ Webhook fatal error:", err);
    // Always 200 for FB
    return res.status(200).send("EVENT_RECEIVED");
  }
}
