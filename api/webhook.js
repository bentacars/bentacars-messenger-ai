// api/webhook.js
// Facebook Messenger ↔ OpenAI Agent Builder (Workflow) bridge

export default async function handler(req, res) {
  try {
    // --- 1) VERIFY WEBHOOK (GET) ---
    if (req.method === "GET") {
      const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("[Webhook] verify: success");
        return res.status(200).send(challenge);
      }
      return res.sendStatus(403);
    }

    // --- 2) HANDLE EVENTS (POST) ---
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const body = req.body;
    if (!body || body.object !== "page" || !Array.isArray(body.entry)) {
      console.warn("[Webhook] invalid body");
      return res.sendStatus(400);
    }

    // We will try to stay under Meta's 20s window by doing the AI call inline.
    // If you see timeouts later, we can add a lightweight "typing_on" first.

    for (const entry of body.entry) {
      const messagingEvents = entry.messaging || [];
      for (const event of messagingEvents) {
        const senderId = event.sender?.id;
        const recipientId = event.recipient?.id;

        // Extract user text (message or postback payload)
        let userText = null;

        if (event.message?.text) {
          userText = event.message.text;
          console.log("📩 MESSAGE EVENT:", JSON.stringify({ text: userText }, null, 2));
        } else if (event.postback?.payload) {
          userText = event.postback.payload;
          console.log("📩 POSTBACK EVENT:", JSON.stringify({ payload: userText }, null, 2));
        }

        if (!senderId || !userText) {
          // Non-text events (reads, deliveries, attachments, etc.) are ignored for now
          continue;
        }

        // Optional: Send "typing_on" to show activity while we call OpenAI
        await sendSenderAction(senderId, "typing_on");

        // --- 3) CALL OPENAI WORKFLOW ---
        const WORKFLOW_ID = "wf_6903132fe2ac8190bd0cf21dbb1420c30aa1dfd0791000f9"; // <-- your workflow
        const aiText = await runWorkflow(userText, {
          fb_user_id: senderId,
          page_id: recipientId,
        });

        // Fallback if workflow didn't return text
        const reply = aiText || `You said: “${userText}”`;

        // --- 4) SEND REPLY BACK TO MESSENGER ---
        await sendTextMessage(senderId, reply);

        // Optional: turn off typing
        await sendSenderAction(senderId, "typing_off");
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.sendStatus(500);
  }
}

/* ------------------------ Helpers ------------------------ */

async function runWorkflow(userText, meta = {}) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT;
  const WORKFLOW_ID = "wf_6903132fe2ac8190bd0cf21dbb1420c30aa1dfd0791000f9";

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Project": OPENAI_PROJECT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow: WORKFLOW_ID,
        input: userText,
        metadata: { channel: "facebook_messenger", ...meta },
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("❌ OpenAI error:", data);
      return null;
    }

    // Try multiple shapes to extract text—Agents/Workflows can return different structures
    let text = null;

    if (typeof data.output_text === "string") {
      text = data.output_text;
    }

    if (!text && Array.isArray(data.output)) {
      // If output is an array of content blocks { type, text }
      text = data.output
        .filter((b) => typeof b?.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
    }

    if (!text && data?.response?.output_text) {
      text = data.response.output_text;
    }

    if (!text && Array.isArray(data?.choices)) {
      const c = data.choices[0];
      const msg = c?.message;
      // message.content could be array of { type: "output_text", text: "..." }
      if (Array.isArray(msg?.content)) {
        const pieces = msg.content
          .map((p) => p?.text || p?.output_text || "")
          .filter(Boolean);
        if (pieces.length) text = pieces.join("\n").trim();
      }
      if (!text && typeof msg?.content === "string") {
        text = msg.content;
      }
    }

    return (text || "").trim();
  } catch (e) {
    console.error("❌ runWorkflow exception:", e);
    return null;
  }
}

async function sendTextMessage(psid, text) {
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(
    PAGE_ACCESS_TOKEN
  )}`;

  const body = {
    recipient: { id: psid },
    message: { text: text.slice(0, 2000) }, // FB limit safeguard
    messaging_type: "RESPONSE",
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("❌ FB SEND ERROR", data);
  } else {
    console.log("✅ Sent:", JSON.stringify(data, null, 2));
  }
}

async function sendSenderAction(psid, action /* typing_on | typing_off | mark_seen */) {
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(
    PAGE_ACCESS_TOKEN
  )}`;

  const body = {
    recipient: { id: psid },
    sender_action: action,
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("⚠️ sender_action error:", e?.message || e);
  }
}
