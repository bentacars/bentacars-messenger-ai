// api/webhook.js
export const config = { runtime: "nodejs" };

/**
 * Minimal dependencies (pure fetch) to avoid SDK version issues.
 * This file:
 *  - Verifies Meta webhook (GET)
 *  - Receives Messenger messages (POST)
 *  - Calls OpenAI Workflows v2 over REST
 *  - Sends one final reply (no double messages / no loop)
 */

const PAGE_TOKEN      = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN    = process.env.META_VERIFY_TOKEN;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const WORKFLOW_ID     = process.env.WORKFLOW_ID;
const OPENAI_PROJECT  = process.env.OPENAI_PROJECT || "";   // optional
const WORKFLOW_VERSION= process.env.WORKFLOW_VERSION || ""; // optional, e.g. "1"

// ---------- Helpers: Facebook ----------
async function fbTyping(recipientId, on = true) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const body = {
    recipient: { id: recipientId },
    sender_action: on ? "typing_on" : "typing_off",
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
  } catch (_) {}
}

async function fbSendText(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const body = {
    recipient: { id: recipientId },
    message: { text },
    messaging_type: "RESPONSE",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    console.error("❌ FB SEND error:", res.status, raw);
    return { ok: false, status: res.status, raw };
  }
  console.log("✅ FB SEND:", raw);
  return { ok: true };
}

// ---------- Helpers: OpenAI Workflows v2 REST ----------
function openAIHeaders() {
  const h = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "workflows=v2",
    "Content-Type": "application/json"
  };
  if (OPENAI_PROJECT) h["OpenAI-Project"] = OPENAI_PROJECT;
  return h;
}

async function startWorkflowRun(userText) {
  const url = `https://api.openai.com/v1/workflows/${encodeURIComponent(WORKFLOW_ID)}/runs`;
  const payload = {
    input: { input_as_text: userText || "" }
  };
  if (WORKFLOW_VERSION) payload.version = WORKFLOW_VERSION;

  const res = await fetch(url, {
    method: "POST",
    headers: openAIHeaders(),
    body: JSON.stringify(payload)
  });
  const raw = await res.text();
  if (!res.ok) {
    console.error("❌ OpenAI start run error:", res.status, raw);
    throw new Error(`OpenAI start run failed: ${res.status} ${raw}`);
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error(`OpenAI start run JSON parse error: ${raw}`);
  }
  const runId = data?.id || data?.run_id || data?.data?.id;
  if (!runId) {
    console.warn("⚠️ Unexpected start run response shape:", data);
    throw new Error("No run id returned by OpenAI Workflows API");
  }
  return runId;
}

async function getWorkflowRun(runId) {
  const url = `https://api.openai.com/v1/workflows/runs/${encodeURIComponent(runId)}`;
  const res = await fetch(url, { headers: openAIHeaders() });
  const raw = await res.text();
  if (!res.ok) {
    console.error("❌ OpenAI get run error:", res.status, raw);
    throw new Error(`OpenAI get run failed: ${res.status} ${raw}`);
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error(`OpenAI get run JSON parse error: ${raw}`);
  }
  return data;
}

function extractFinalTextFromRun(runJson) {
  // Try common shapes from Workflows v2 runs
  // 1) outputs[0].content[0].text   (text)
  try {
    const c0 = runJson?.output?.[0]?.content?.[0];
    if (c0?.type === "text" && typeof c0?.text === "string") return c0.text.trim();
    if (c0?.type === "output_text" && typeof c0?.text === "string") return c0.text.trim();
  } catch (_) {}

  // 2) outputs[0].content[*].json.message  (json content with message)
  try {
    const arr = runJson?.output?.[0]?.content || [];
    for (const item of arr) {
      if (item?.type === "json" && item?.json?.message && typeof item.json.message === "string") {
        return item.json.message.trim();
      }
    }
  } catch (_) {}

  // 3) Some workflows put a top-level message
  try {
    const msg = runJson?.message || runJson?.output?.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  } catch (_) {}

  // 4) Give up—return a short fallback plus small snippet for debug
  return "Salamat! Iche-check ko ang best match para sa inyo. 🚗";
}

async function runWorkflowToMessage(userText, opts = { maxPollMs: 15000, intervalMs: 1200 }) {
  const runId = await startWorkflowRun(userText);

  const t0 = Date.now();
  while (Date.now() - t0 < opts.maxPollMs) {
    const run = await getWorkflowRun(runId);
    const status = run?.status || run?.state || "";
    console.log("ℹ️ Workflow status:", status);

    if (status === "completed" || status === "succeeded" || status === "ok") {
      return extractFinalTextFromRun(run);
    }
    if (status === "failed" || status === "error" || status === "cancelled") {
      console.error("❌ Workflow failed:", JSON.stringify(run).slice(0, 800));
      return "Medyo may issue sa processing. Try ulit po in a moment. 🙏";
    }
    await new Promise(r => setTimeout(r, opts.intervalMs));
  }
  console.warn("⏱️ Workflow poll timeout");
  return "Thanks! Medyo mabagal ang processing ngayon—balikan ko kayo shortly. 🙏";
}

// ---------- Main HTTP handler ----------
export default async function handler(req, res) {
  try {
    // --- Meta verify handshake ---
    if (req.method === "GET") {
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

    if (!PAGE_TOKEN || !VERIFY_TOKEN || !OPENAI_API_KEY || !WORKFLOW_ID) {
      console.error("❌ Missing env vars. Required: PAGE_ACCESS_TOKEN, META_VERIFY_TOKEN, OPENAI_API_KEY, WORKFLOW_ID");
      res.status(200).send("EVENT_RECEIVED");
      return;
    }

    const raw = req.body || {};
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;

    if (!payload?.entry?.length) {
      console.warn("⚠️ No entry in payload");
      res.status(200).send("EVENT_RECEIVED");
      return;
    }

    for (const entry of payload.entry) {
      const messagings = entry?.messaging || [];
      for (const m of messagings) {
        const senderId = m?.sender?.id;
        const text = m?.message?.text?.trim();

        if (!senderId || !text) continue;

        console.log("🟢 Incoming:", { senderId, text });

        // One clear flow: typing → workflow → final reply (no extra welcome to avoid double messages)
        await fbTyping(senderId, true);
        let reply;
        try {
          reply = await runWorkflowToMessage(text);
        } catch (err) {
          console.error("❌ Workflow v2 call failed:", err);
          reply = "Nagka-issue sa processing. Paki-try ulit po. 🙏";
        }
        await fbSendText(senderId, reply);
        await fbTyping(senderId, false);
      }
    }

    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("❌ Webhook fatal:", err);
    // Always 200 for Facebook so it doesn't keep retrying
    res.status(200).send("EVENT_RECEIVED");
  }
}
