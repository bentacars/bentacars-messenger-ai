// api/webhook.js
export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const WORKFLOW_ID = process.env.WORKFLOW_ID; // wf_...

  // ---- 1) VERIFY WEBHOOK (GET) ----
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified ✅");
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // ---- 2) HANDLE EVENTS (POST) ----
  if (req.method === "POST") {
    try {
      const body = req.body;

      // Basic guard
      if (body.object !== "page" || !Array.isArray(body.entry)) {
        return res.status(200).send("EVENT_RECEIVED");
      }

      // Loop entries (Meta can batch)
      for (const entry of body.entry) {
        const messagingEvents = entry.messaging || [];
        for (const event of messagingEvents) {
          if (event.message && !event.message.is_echo) {
            await handleMessage(event, PAGE_ACCESS_TOKEN, OPENAI_API_KEY, WORKFLOW_ID);
          } else if (event.postback) {
            // Optional: handle postbacks as text
            const text = event.postback.title || "Postback";
            await sendTyping(event.sender.id, PAGE_ACCESS_TOKEN, true);
            await sendText(event.sender.id, `You tapped: “${text}”`, PAGE_ACCESS_TOKEN);
            await sendTyping(event.sender.id, PAGE_ACCESS_TOKEN, false);
          }
        }
      }

      // Respond immediately so Meta won't retry
      return res.status(200).send("EVENT_RECEIVED");
    } catch (err) {
      console.error("Webhook error:", err);
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(404).send("Not Found");
}

// ---------- Helpers ----------

async function handleMessage(event, PAGE_ACCESS_TOKEN, OPENAI_API_KEY, WORKFLOW_ID) {
  const senderId = event.sender?.id;
  const text = event.message?.text?.trim() || "";

  if (!senderId) return;
  if (!text) {
    await sendText(senderId, "Sorry, I didn’t get that. Can you repeat?", PAGE_ACCESS_TOKEN);
    return;
  }

  // quick ack + typing
  await sendTyping(senderId, PAGE_ACCESS_TOKEN, true);
  await sendText(senderId, "Thanks! Let me check that for you.", PAGE_ACCESS_TOKEN);

  try {
    // ---- Call OpenAI Responses API (WORKFLOW TYPE A) ----
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        // IMPORTANT: workflow call using input_as_text (TYPE A)
        workflow: { id: WORKFLOW_ID, version: "2" },
        input: { input_as_text: text }
      })
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("OpenAI error:", data);
      await sendText(
        senderId,
        "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏",
        PAGE_ACCESS_TOKEN
      );
      await sendTyping(senderId, PAGE_ACCESS_TOKEN, false);
      return;
    }

    // Responses API can return multiple output items; get first useful text
    const replyText = extractReplyText(data) || "Okay po! ✅";
    await sendText(senderId, replyText, PAGE_ACCESS_TOKEN);
  } catch (e) {
    console.error("Call OpenAI failed:", e);
    await sendText(
      senderId,
      "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏",
      PAGE_ACCESS_TOKEN
    );
  } finally {
    await sendTyping(senderId, PAGE_ACCESS_TOKEN, false);
  }
}

function extractReplyText(responseJson) {
  // Try common shapes from Responses API
  // 1) top-level output_text
  if (typeof responseJson.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  // 2) Iterate outputs[].content[].text
  if (Array.isArray(responseJson.output)) {
    for (const item of responseJson.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "output_text" && c.text && c.text.trim()) {
            return c.text.trim();
          }
          if (c.type === "text" && c.text && c.text.trim()) {
            return c.text.trim();
          }
        }
      }
    }
  }

  // 3) Fallback: stringify minimal
  try {
    return JSON.stringify(responseJson).slice(0, 800);
  } catch {
    return null;
  }
}

async function sendText(recipientId, text, PAGE_ACCESS_TOKEN) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload = {
    recipient: { id: recipientId },
    message: { text }
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  // Log but do not break flow
  if (!r.ok) console.error("FB SEND ERROR", j);
  else console.log("FB SEND RESULT:", j);
}

async function sendTyping(recipientId, PAGE_ACCESS_TOKEN, isTyping) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const payload = {
    recipient: { id: recipientId },
    sender_action: isTyping ? "typing_on" : "typing_off"
  };
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}
