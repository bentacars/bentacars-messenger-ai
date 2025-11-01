// api/webhook.js  (ESM, Node 18+)

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini"; // swap to "gpt-5" later

const FB_GRAPH = "https://graph.facebook.com/v21.0";

// --- helpers ---
async function sendToMessenger(recipientId, text) {
  const url = `${FB_GRAPH}/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const body = {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: { text }
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.text();
    console.error("[FB SEND ERROR]", r.status, e);
  }
}

async function callOpenAI(userText) {
  const prompt = [
    {
      role: "system",
      content:
        "You are BentaCars' AI sales assistant. Auto-detect the user's tone and language (English/Taglish) and mirror it. " +
        "Be concise, friendly, and helpful. Priority services: used car financing, cash for used cars, sangla OR/CR. " +
        "When relevant, ask one thoughtful follow-up to move the deal forward (budget, location, income source, car model/year, OR/CR name). " +
        "Avoid long lists and emojis unless the user uses them first."
    },
    { role: "user", content: userText }
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,          // change to "gpt-5" when available
      messages: prompt,
      temperature: 0.6,
    }),
  });

  if (!r.ok) {
    const err = await r.text();
    console.error("[OPENAI ERROR]", r.status, err);
    return "Sorry, nagka-error saglit. Pwede pakiulit ng message? 🙏";
  }

  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim()
      || "Got it! How can I help you with car financing or unit matching today?";
}

// --- webhook handler ---
export default async function handler(req, res) {
  // 1) Webhook verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("[Webhook] verify: success");
      res.status(200).send(challenge);
    } else {
      console.warn("[Webhook] verify: failed");
      res.sendStatus(403);
    }
    return;
  }

  // 2) Handle events (POST)
  if (req.method === "POST") {
    try {
      const body = req.body;

      if (body.object !== "page" || !Array.isArray(body.entry)) {
        res.sendStatus(404);
        return;
      }

      for (const entry of body.entry) {
        const events = entry.messaging || [];
        for (const ev of events) {
          const senderId = ev.sender?.id;
          if (!senderId) continue;

          // a) Text messages
          if (ev.message?.text) {
            const userText = ev.message.text.trim();
            console.log("[MESSAGE EVENT]", { text: userText });

            const reply = await callOpenAI(userText);
            await sendToMessenger(senderId, reply);
          }

          // b) Postbacks (buttons / quick replies)
          if (ev.postback?.payload) {
            const payload = ev.postback.payload;
            console.log("[POSTBACK EVENT]", { payload });

            const reply = await callOpenAI(`User clicked: ${payload}. Respond briefly and continue the conversation.`);
            await sendToMessenger(senderId, reply);
          }
        }
      }

      res.status(200).send("EVENT_RECEIVED");
    } catch (e) {
      console.error("[WEBHOOK ERROR]", e);
      res.status(200).send("EVENT_RECEIVED"); // 200 so Meta doesn’t retry forever
    }
    return;
  }

  res.status(404).send("Not Found");
}
