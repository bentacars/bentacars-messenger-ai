// api/webhook.js
// Vercel — Node runtime
export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import fetch from "node-fetch";

// ----- ENV -----
const PAGE_TOKEN     = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN   = process.env.META_VERIFY_TOKEN;
const OPENAI_KEY     = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || "";
const WORKFLOW_ID    = process.env.WORKFLOW_ID;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4.1";

// ----- OpenAI client (SDK handles versioning) -----
const openai = new OpenAI({
  apiKey: OPENAI_KEY,
  ...(OPENAI_PROJECT ? { project: OPENAI_PROJECT } : {}),
});

// ----- Anti-loop globals (in-memory TTL maps) -----
// De-dupe exact FB message deliveries by mid for 10s
const processedMids = new Map(); // mid -> expiresAt (ms)
const MID_TTL_MS = 10_000;
// Throttle welcome per sender (avoid welcome spam) for 2 mins
const lastWelcomeAt = new Map(); // senderId -> ts (ms)
const WELCOME_COOLDOWN_MS = 120_000;

function gcMaps() {
  const now = Date.now();
  for (const [mid, exp] of processedMids.entries()) if (exp <= now) processedMids.delete(mid);
  // (lastWelcomeAt can be left to grow; optional GC)
}

// ----- FB send helper -----
async function fbSendText(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
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

// ----- Simple intent detector (Taglish + common terms) -----
const USED_CAR_REGEX = /\b(buy|looking|hanap|bili|kuha|used\s*car|second[-\s]?hand|preowned|mirage|vios|fortuner|innova|civic|city|avanza|hatchback|sedan|suv|mpv|van|pickup|sangla|orcr|financ(?:e|ing)|loan|dp|downpayment|down\s*payment)\b/i;

// ----- Welcome chat (normal LLM reply) -----
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
      "Hi po! Welcome to BentaCars 😊 Interested po ba kayo sa used-car options or need ninyo ng tulong sa financing?"
    );
  } catch (err) {
    console.error("❌ OpenAI chat error:", err);
    return "Hi po! Welcome to BentaCars 😊 How can we help you today?";
  }
}

// ----- Run Workflow v2 (SDK first; else raw v2 HTTPS) -----
async function runWorkflowV2(inputText) {
  if (!WORKFLOW_ID) throw new Error("WORKFLOW_ID env is missing");

  const extractTextFromRun = (runObj) => {
    try {
      const out0 = runObj?.output?.[0] || runObj?.run?.output?.[0];
      const content0 = out0?.content?.[0];
      if (content0?.type === "output_text" && content0?.text) return content0.text;
      if (content0?.type === "text" && content0?.text) return content0.text;
      const jsonMsg = out0?.content?.find?.((c) => c?.type === "json")?.json?.message;
      if (typeof jsonMsg === "string" && jsonMsg.trim()) return jsonMsg;
      if (Array.isArray(runObj?.output) && typeof runObj.output[0] === "string") return runObj.output[0];
    } catch (_) {}
    return null;
  };

  try {
    const hasSDK =
      openai?.beta?.workflows?.runs?.create &&
      typeof openai.beta.workflows.runs.create === "function";

    if (hasSDK) {
      const run = await openai.beta.workflows.runs.create({
        workflow_id: WORKFLOW_ID,
        input: { input_as_text: inputText },
      });
      const msg = extractTextFromRun(run);
      if (msg) return msg.trim();
      console.warn("⚠️ Unrecognized workflow output (SDK):", JSON.stringify(run).slice(0, 800));
      return "Thanks! Let me check matching units for you now. 🚗";
    }

    // Raw v2 HTTP call
    const url = `https://api.openai.com/v2/workflows/${encodeURIComponent(WORKFLOW_ID)}/runs`;
    const headers = {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    };
    if (OPENAI_PROJECT) headers["OpenAI-Project"] = OPENAI_PROJECT;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { input_as_text: inputText } }),
    });

    const raw = await resp.text();
    if (!resp.ok) {
      console.error("❌ Workflow v2 HTTP error:", resp.status, raw);
      return "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏";
    }

    let data;
    try { data = JSON.parse(raw); }
    catch (e) {
      console.error("❌ Workflow v2 JSON parse error:", e, raw.slice(0, 400));
      return "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏";
    }

    const msg = extractTextFromRun(data);
    if (msg) return msg.trim();
    console.warn("⚠️ Unrecognized workflow output (HTTP):", JSON.stringify(data).slice(0, 800));
    return "Thanks! Let me check matching units for you now. 🚗";
  } catch (err) {
    console.error("❌ Workflow v2 failed:", err);
    return "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏";
  }
}

// ----- Main handler -----
export default async function handler(req, res) {
  try {
    // FB webhook verify
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verify: success");
        return res.status(200).send(challenge);
      }
      console.warn("❌ Webhook verify: failed");
      return res.status(403).send("Forbidden");
    }

    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const body = req.body || {};
    const payload = typeof body === "string" ? JSON.parse(body) : body;

    if (!payload?.entry?.length) {
      console.warn("⚠️ No entries in webhook payload");
      return res.status(200).send("EVENT_RECEIVED");
    }

    gcMaps(); // cleanup old dedupe entries

    for (const entry of payload.entry) {
      const messagings = entry?.messaging || [];
      for (const m of messagings) {
        // Ignore non-message events & echoes
        if (!m?.message || m?.message?.is_echo) continue;

        const senderId = m?.sender?.id;
        const textRaw  = m?.message?.text;
        const mid      = m?.message?.mid;

        if (!senderId || !textRaw || !mid) continue;

        // De-dupe by message id (10s window)
        if (processedMids.has(mid)) {
          console.log("🟨 Skipping duplicate mid:", mid);
          continue;
        }
        processedMids.set(mid, Date.now() + MID_TTL_MS);

        const text = textRaw.trim();
        console.log("🟢 Incoming:", { senderId, text });

        // Throttled welcome (no spam)
        const lastW = lastWelcomeAt.get(senderId) || 0;
        const now = Date.now();
        if (now - lastW > WELCOME_COOLDOWN_MS) {
          const welcome = await getWelcomeReply(text);
          await fbSendText(senderId, welcome);
          lastWelcomeAt.set(senderId, now);
        }

        // Intent: only then run workflow v2
        if (USED_CAR_REGEX.test(text)) {
          await fbSendText(senderId, "Salamat! Iche-check ko muna ang available options based sa gusto ninyo. ⏳");
          const wfReply = await runWorkflowV2(text);
          await fbSendText(senderId, wfReply);
        }
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("❌ Webhook fatal error:", err);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
