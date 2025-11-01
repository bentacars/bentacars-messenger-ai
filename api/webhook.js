// api/webhook.js
import fetch from "node-fetch";

const VERIFY_TOKEN   = process.env.META_VERIFY_TOKEN;
const PAGE_TOKEN     = process.env.META_PAGE_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || "";
const WORKFLOW_ID    = process.env.WORKFLOW_ID; // wf_... from Agent Builder

export default async function handler(req, res) {
  try {
    // --- 1) VERIFY (GET) ---
    if (req.method === "GET") {
      const mode       = req.query["hub.mode"];
      const token      = req.query["hub.verify_token"];
      const challenge  = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified!");
        return res.status(200).send(challenge);
      }
      return res.sendStatus(403);
    }

    // --- 2) RECEIVE EVENTS (POST) ---
    if (req.method !== "POST") {
      return res.status(404).send("Not Found");
    }

    const body = req.body || {};
    if (body.object !== "page" || !Array.isArray(body.entry)) {
      // Not a Messenger event; just ACK.
      return res.status(200).send("EVENT_RECEIVED");
    }

    // Handle each messaging event
    for (const entry of body.entry) {
      const events = entry.messaging || [];
      for (const event of events) {
        const senderId = event?.sender?.id;
        const text     = event?.message?.text;

        // Only handle text messages for now
        if (!senderId || !text) continue;

        // 2a) Get AI reply from your Workflow
        const reply = await runWorkflow(text);

        // 2b) Send reply back to Messenger
        await sendToMessenger(senderId, reply || "Got it! ✅");
      }
    }

    // Respond to Meta immediately
    return res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("EVENT_RECEIVED");
  }
}

// ---- OpenAI: call your Agent Builder WORKFLOW via Responses API ----
async function runWorkflow(userText) {
  try {
    // Preferred: Responses API with workflow
    const payload = {
      // The model here is ignored by the workflow’s internal nodes,
      // but Responses API requires a model field; keep a sane default.
      model: "gpt-4.1-mini",
      input: [
        { role: "user", content: userText }
      ],
      workflow: { id: WORKFLOW_ID },
      // Ensure we want text out
      modalities: ["text"]
    };

    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    };
    if (OPENAI_PROJECT) headers["OpenAI-Project"] = OPENAI_PROJECT;

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("OpenAI error:", data);
      return "You said: " + userText; // graceful fallback
    }

    // Prefer unified text output if present
    if (data.output_text) return data.output_text.trim();

    // Fallbacks for different shapes
    if (data.output && Array.isArray(data.output)) {
      const firstText = data.output.find(
        b => b?.content?.[0]?.type === "output_text" && b.content[0].text
      );
      if (firstText) return firstText.content[0].text.trim();
    }

    // Ultimate fallback
    return "Thanks! How can I help you with used cars or financing?";
  } catch (e) {
    console.error("runWorkflow failed:", e);
    return "Salamat! How can I assist you today?";
  }
}

// ---- Facebook Send API ----
async function sendToMessenger(psid, text) {
  try {
    const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
    const body = {
      recipient: { id: psid },
      message:   { text }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("FB SEND ERROR", r.status, err);
    }
  } catch (e) {
    console.error("sendToMessenger failed:", e);
  }
}
