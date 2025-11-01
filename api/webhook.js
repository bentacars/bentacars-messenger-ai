export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT;
  const WORKFLOW_ID = process.env.WORKFLOW_ID;

  // 1️⃣ Webhook verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified!");
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send("Forbidden");
    }
  }

  // 2️⃣ Handle incoming Webhook events (POST)
  if (req.method === "POST") {
    console.log("📩 Incoming webhook event:", JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const messagingEvent = entry?.messaging?.[0];

    if (messagingEvent?.message?.text) {
      const senderId = messagingEvent.sender.id;
      const userMessage = messagingEvent.message.text;

      console.log(`➡️ User (${senderId}) said: "${userMessage}"`);

      try {
        // 3️⃣ Send message to OpenAI Workflow
        const aiResponse = await fetch(
          `https://api.openai.com/v1/workflows/${WORKFLOW_ID}/runs`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              "OpenAI-Project": OPENAI_PROJECT
            },
            body: JSON.stringify({
              input: { user_message: userMessage }
            })
          }
        );

        const aiData = await aiResponse.json();
        console.log("🤖 AI Raw Response:", JSON.stringify(aiData, null, 2));

        let botReply =
          aiData.output?.reply ||
          aiData.output?.assistant_response ||
          "Sorry, I didn’t get that. Can you repeat?";

        // 4️⃣ Send reply back to Messenger
        await sendMessage(senderId, botReply);
      } catch (err) {
        console.error("❌ Error calling OpenAI:", err);
        await sendMessage(senderId, "May error saglit, retry tayo...");
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(404).send("Not Found");
}

// ✅ Helper: Send a message back to Facebook Messenger
async function sendMessage(recipientId, text) {
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

  const url = `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const body = {
    recipient: { id: recipientId },
    message: { text }
  };

  const fbRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const result = await fbRes.json();
  console.log("✅ FB MESSAGE SENT:", result);

  return result;
}
