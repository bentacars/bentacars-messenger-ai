// /api/webhook.js
export const config = { runtime: "nodejs" };

import fetch from "node-fetch";

// ---- Env ----
const PAGE_TOKEN     = process.env.PAGE_ACCESS_TOKEN;   // Meta Page Access Token
const VERIFY_TOKEN   = process.env.META_VERIFY_TOKEN;   // Any value you set in Meta
const OPENAI_KEY     = process.env.OPENAI_API_KEY;      // sk-... (project key OK)
const WORKFLOW_ID    = process.env.WORKFLOW_ID;         // wf_6903...
const WORKFLOW_VER   = process.env.WORKFLOW_VERSION || "1"; // "1" (string)

// ---- Simple, in-memory de-dupe to stop loops ----
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

// ---- FB send helper ----
async function fbSendText(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_TOKEN}`;
  const body = {
    messaging_type: "RESPONSE",
    recipient: { id: recipientId },
    message: { text: text.slice(0, 2000) }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error("FB SEND ERROR:", res.status, err);
  }
}

// ---- Call OpenAI Workflows REST (v2) ----
async function runWorkflowV1(userText) {
  // 1) Create run
  const createRes = await fetch(
    `https://api.openai.com/v1/workflows/${WORKFLOW_ID}/runs`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "OpenAI-Beta": "workflows=v2",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: { input_as_text: userText },
        version: WORKFLOW_VER   // must be a string like "1"
      })
    }
  );

  if (!createRes.ok) {
    const t = await createRes.text().catch(() => "");
    console.error("Create run failed:", createRes.status, t);
    return null;
  }
  const created = await createRes.json();
  const runId = created?.id || created?.run_id || created?.data?.id;
  if (!runId) {
    console.error("No run id in create response:", created);
    return null;
  }

  // 2) Poll for completion (up to ~12s)
  const started = Date.now();
  while (Date.now() - started < 12000) {
    await new Promise(r => setTimeout(r, 1000));
    const getRes = await fetch(
      `https://api.openai.com/v1/workflows/runs/${runId}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${OPENAI_KEY}`,
          "OpenAI-Beta": "workflows=v2"
        }
      }
    );

    if (!getRes.ok) {
      const t = await getRes.text().catch(() => "");
      console.error("Get run failed:", getRes.status, t);
      continue;
    }
    const run = await getRes.json();

    if (run?.status === "completed" || run?.status === "succeeded") {
      // Try multiple likely shapes to extract a message string safely
      const candidates = [];

      // Common fields we might see
      if (typeof run.output_text === "string") candidates.push(run.output_text);
      if (Array.isArray(run.outputs_text)) candidates.push(run.outputs_text.join("\n"));

      // Generic: scan outputs/content for any text blocks
      const digTexts = (obj) => {
        if (!obj) return;
        if (typeof obj === "string") candidates.push(obj);
        if (Array.isArray(obj)) obj.forEach(digTexts);
        else if (typeof obj === "object") Object.values(obj).forEach(digTexts);
      };
      digTexts(run.outputs);
      digTexts(run.final_output);
      digTexts(run.output);

      const msg = (candidates.find(s => typeof s === "string" && s.trim().length > 0) || "").trim();
      return msg || "✅ Done. (But no text output was returned by the workflow.)";
    }

    if (run?.status === "failed" || run?.status === "errored" || run?.error) {
      console.error("Run failed:", run);
      return null;
    }
  }

  console.warn("Run timed out waiting for completion.");
  return null;
}

// ---- Webhook handler ----
export default async function handler(req, res) {
  try {
    // Meta verify (GET)
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).send("Forbidden");
    }

    // Messages (POST)
    if (req.method === "POST") {
      const body = req.body;

      const entry = body?.entry?.[0];
      const messaging = entry?.messaging?.[0];
      const senderId = messaging?.sender?.id;
      const messageId = messaging?.message?.mid || messaging?.message?.message_id;
      const text = messaging?.message?.text || "";

      if (!senderId || !messageId) {
        return res.status(200).json({ ok: true });
      }

      if (alreadyHandled(messageId)) {
        return res.status(200).json({ ok: true, deduped: true });
      }

      console.log("Incoming:", { senderId, messageId, text });

      // Call your Workflow
      let reply = await runWorkflowV1(text);

      if (!reply || !reply.trim()) {
        reply = "Medyo nagka-issue sa processing. Pakisubukan ulit in a moment 🙏";
      }

      await fbSendText(senderId, reply);
      return res.status(200).json({ ok: true });
    }

    res.status(405).send("Method Not Allowed");
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    res.status(200).json({ ok: false });
  }
}
