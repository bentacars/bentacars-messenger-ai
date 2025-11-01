export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

  // 1️⃣ Handle Verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified!");
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send("Verification failed");
    }
  }

  // 2️⃣ Handle Incoming Webhook Events (POST)
  if (req.method === "POST") {
    try {
      const body = req.body;
      console.log("📩 Incoming webhook:", JSON.stringify(body, null, 2));

      // Check if this is a real user message
      const entry = body.entry?.[0];
      const messaging = entry?.messaging?.[0];
      const senderId = messaging?.sender?.id;
      const messageText = messaging?.message?.text;

      // Detect fake test events (Meta Test UI or cURL)
      const isTestEvent =
        senderId === "USER_ID" ||
        senderId?.includes("PAGE") ||
        senderId?.length < 5;

      console.log("ℹ️ senderId =", senderId);
      console.log("ℹ️ isTestEvent =", isTestEvent);

      // ✅ Always acknowledge so Meta stops retrying
      res.status(200).send("EVENT_RECEIVED");

      // 🧪 If this is a test event → DO NOT reply
      if (isTestEvent) {
        console.log("🛑 Test event detected — skipping reply.");
        return;
      }

      // ✅ For real Messenger users, reply back
      await sendMessage(senderId, `You said: "${messageText}"`);
      console.log("✅ Reply sent to user:", senderId);

    } catch (err) {
      console.error("🔥 Webhook error:", err);
      return res.status(500).send("Webhook error");
    }
  }

  return res.status(404).send("Not Found");
}

// ✅ Send message back to Facebook user
async function sendMessage(recipientId, text) {
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

  await fetch(
    `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text },
      }),
    }
  );
}
