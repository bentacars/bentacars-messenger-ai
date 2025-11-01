export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

  // ✅ Facebook Webhook Verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified!");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }

  // ✅ Handle Incoming Webhook Events (POST)
  if (req.method === "POST") {
    console.log("📩 Incoming webhook event:", JSON.stringify(req.body, null, 2));

    if (req.body.object === "page") {
      req.body.entry.forEach((entry) => {
        const webhookEvent = entry.messaging?.[0];

        console.log("🔍 Parsed event:", webhookEvent);

        if (!webhookEvent) return;

        // ✅ Handle text messages only
        if (webhookEvent.message && webhookEvent.message.text) {
          const userText = webhookEvent.message.text;
          const senderId = webhookEvent.sender.id;

          console.log(`🗣️ User (${senderId}) said:`, userText);

          // ✅ Send this message to your Agent / OpenAI
          handleUserMessage(senderId, userText);
        }
      });

      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.sendStatus(404);
}

// ✅ Forward text to AI + reply back to Messenger
async function handleUserMessage(userId, text) {
  try {
    console.log(`🤖 Sending to AI: "${text}"`);

    // ===== CALL YOUR AGENT HERE =====
    // (temporary example response below)
    const botReply = `You said: ${text}`;

    console.log(`✉️ Replying back: "${botReply}"`);

    await sendMessengerReply(userId, botReply);
  } catch (error) {
    console.error("❌ Error in handleUserMessage:", error);
  }
}

// ✅ Send response back to Messenger API
async function sendMessengerReply(userId, text) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`;

  const payload = {
    messaging_type: "RESPONSE",
    recipient: { id: userId },
    message: { text }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log("📩 Facebook API response:", data);
}
