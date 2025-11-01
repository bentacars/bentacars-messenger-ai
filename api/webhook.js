// api/webhook.js
// Persistent FB Messenger → OpenAI Agent Workflow relay (with per-user threads)

const META_GRAPH_VERSION = "v21.0"; // ok to use v20+; update if needed

// ----- ENV -----
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;       // FB Page token
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;       // FB webhook verify token
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;          // OpenAI API key
const OPENAI_PROJECT    = process.env.OPENAI_PROJECT;          // OpenAI project id (Header)
const WORKFLOW_ID       = process.env.WORKFLOW_ID;             // Agent Builder Workflow ID

// Optional (recommended) persistent KV (Vercel KV / Upstash REST):
const KV_URL   = process.env.KV_REST_API_URL;                  // e.g., https://us1-firm…upstash.io
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Quick guard
function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env: ${name}`);
}
requireEnv("PAGE_ACCESS_TOKEN", PAGE_ACCESS_TOKEN);
requireEnv("META_VERIFY_TOKEN", META_VERIFY_TOKEN);
requireEnv("OPENAI_API_KEY", OPENAI_API_KEY);
requireEnv("OPENAI_PROJECT", OPENAI_PROJECT);
requireEnv("WORKFLOW_ID", WORKFLOW_ID);

// ----- Minimal KV helper (uses Upstash/Vercel KV REST if configured) -----
const inMemoryThreads = new Map(); // fallback if KV not configured (volatile)

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return inMemoryThreads.get(key) || null;
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.result ?? null;
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) {
    inMemoryThreads.set(key, value);
    return true;
  }
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  return res.ok;
}

// ----- Meta helpers -----
async function sendTyping(recipientId, on = true) {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const body = {
    recipient: { id: recipientId },
    sender_action: on ? "typing_on" : "typing_off",
  };
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sendText(recipientId, text) {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const body = {
    recipient: { id: recipientId },
    message: { text },
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const e = await resp.text();
    console.error("FB SEND ERROR", resp.status, e);
  }
}

// ----- OpenAI helpers (Agent Builder Workflows) -----
// Create a new thread once per PSID
async function createThread() {
  const res = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Project": OPENAI_PROJECT,
    },
    body: "{}",
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI createThread error: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.id; // "thread_..."
}

// Start a workflow run on an existing thread and wait for completion
async function runWorkflowAndGetReply({ threadId, userText }) {
  // Start run
  const start = await fetch(
    `https://api.openai.com/v1/agent/workflows/${WORKFLOW_ID}/runs`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Project": OPENAI_PROJECT,
      },
      body: JSON.stringify({
        thread_id: threadId,    // persist conversation state
        input: userText,        // the user's new message
        stream: false
      }),
    }
  );

  if (!start.ok) {
    const err = await start.text();
    throw new Error(`OpenAI start run error: ${start.status} ${err}`);
  }

  const run = await start.json();
  const runId = run.id;

  // Poll run status until completed/cancelled/failed/time_out
  async function getRun() {
    const r = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Project": OPENAI_PROJECT,
        },
        cache: "no-store",
      }
    );
    if (!r.ok) throw new Error(`OpenAI getRun failed ${r.status}`);
    return r.json();
  }

  // Simple polling loop
  let attempts = 0;
  while (attempts < 40) { // ~20s if 500ms each
    const cur = await getRun();
    const st = cur.status;
    if (st === "completed") break;
    if (["failed", "cancelled", "expired"].includes(st)) {
      throw new Error(`Run ended with status=${st}`);
    }
    await new Promise(r => setTimeout(r, 500));
    attempts++;
  }

  // Fetch latest assistant message(s)
  const msgsRes = await fetch(
    `https://api.openai.com/v1/threads/${threadId}/messages?limit=10&order=desc`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Project": OPENAI_PROJECT,
      },
      cache: "no-store",
    }
  );
  if (!msgsRes.ok) {
    const t = await msgsRes.text();
    throw new Error(`OpenAI messages error: ${msgsRes.status} ${t}`);
  }
  const msgs = await msgsRes.json();

  // Find first assistant message text
  for (const m of msgs.data || []) {
    if (m.role === "assistant") {
      // Prefer plain text
      const textPart = (m.content || []).find(c => c.type === "output_text" || c.type === "text");
      if (textPart?.text?.value) return textPart.text.value;
      if (textPart?.text) return textPart.text;
      // As final fallback, stringify
      return JSON.stringify(m.content);
    }
  }
  return null;
}

// ----- Main handler -----
export default async function handler(req, res) {
  try {
    // 1) Webhook verification (GET)
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
        console.log("✅ Webhook verified");
        return res.status(200).send(challenge);
      } else {
        return res.status(403).send("Forbidden");
      }
    }

    // 2) Incoming events (POST)
    if (req.method === "POST") {
      const body = req.body;
      // Meta sometimes sends non-page events; guard
      if (body.object !== "page" || !Array.isArray(body.entry)) {
        return res.status(200).send("EVENT_RECEIVED");
      }

      // Process each messaging event (best-effort, no await to keep webhook snappy)
      for (const entry of body.entry) {
        const evts = entry.messaging || [];
        for (const event of evts) {
          const senderId = event.sender?.id;
          const messageText = event.message?.text;

          // Only handle text messages for now
          if (!senderId || !messageText) continue;

          (async () => {
            try {
              console.log("📩 Incoming:", { senderId, text: messageText });

              // typing on
              await sendTyping(senderId, true);

              // Fetch or create thread id for this user
              const kvKey = `thread:${senderId}`;
              let threadId = await kvGet(kvKey);
              if (!threadId) {
                threadId = await createThread();
                await kvSet(kvKey, threadId);
                console.log("🪵 Created new thread:", threadId);
              }

              // Run the workflow and get reply
              const reply = await runWorkflowAndGetReply({
                threadId,
                userText: messageText,
              });

              const safeReply =
                reply && typeof reply === "string"
                  ? reply.slice(0, 1900) // FB limit safety
                  : "Thanks! Let me check that for you.";

              await sendText(senderId, safeReply);
              await sendTyping(senderId, false);

              console.log("✅ Sent reply:", safeReply);
            } catch (err) {
              console.error("❌ Handler error:", err);
              // Friendly fallback
              await sendText(
                senderId,
                "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏"
              );
            }
          })();
        }
      }

      // Respond immediately so Meta doesn’t retry
      return res.status(200).send("EVENT_RECEIVED");
    }

    return res.status(404).send("Not Found");
  } catch (e) {
    console.error("⚠️ Top-level error:", e);
    return res.status(500).send("Server error");
  }
}
