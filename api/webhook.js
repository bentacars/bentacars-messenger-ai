// -------------------
//  WEBHOOK.JS (FETCH VERSION)
// -------------------

export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const WORKFLOW_ID = process.env.WORKFLOW_ID;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT;

  // ✅ 1. WEBHOOK VERIFICATION (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ WEBHOOK VERIFIED");
      return res.status(200).send(challenge);
    } else {
      console.log("❌ WEBHOOK VERIFICATION FAILED");
      return res.sendStatus(403);
    }
  }

  // ✅ 2. HANDLE MESSAGES (POST)
  if (req.method === "POST") {
    console.log("📩 Incoming webhook payload:", JSON.stringify(req.body, null, 2));

    try {
      const body = req.body;

      if (body.object === "page") {
        for (const entry of body.entry) {
          const event = entry.messaging && entry.messaging[0];

          if (!event) continue;

          const senderId = event.sender.id;
          const textMessage = event.message?.text;
          const postback = event.postback?.payload;

          if (textMessage) {
            console.log("📝 USER SAID:", textMessage);
            await processUserMessage(senderId, textMessage);
          } else if (postback) {
            console.log("🔘 POSTBACK:", postback);
            await processUserMessage(senderId, postback);
          } else {
            console.log("⚠️ Unsupported event received");
          }
        }

        return res.status(200).send("EVENT_RECEIVED");
      }

      return res.sendStatus(404);
    } catch (err) {
      console.error("🔥 ERROR IN POST HANDLER:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.sendStatus(405);
}

// ✅ 3. SEND USER MESSAGE INTO OPENAI WORKFLOW
async function processUserMessage(userId, userText) {
  console.log("🚀 Trigger Workflow:", userText);

  const WORKFLOW_ID = process.env.WORKFLOW_ID;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT;

  const workflowCall = await fetch(
    `https://api.openai.com/v1/workflows/${WORKFLOW_ID}/runs`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Project": OPENAI_PROJECT,
      },
      body: JSON.stringify({
        input: { user_message: userText },
      }),
    }
  );

  const workflowResult = await workflowCall.json();
  console.log("🔎 WORKFLOW RESPONSE:", workflowResult);

  const aiReply =
    workflowResult?.output?.assistant_response || "Thanks! Let me check that for you.";

  await sendMessage(userId, aiReply);
}

// ✅ 4. SEND MESSAGE BACK TO FACEBOOK MESSENGER
async function sendMessage(recipientId, messageText) {
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

  const url = `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const payload = {
    recipient: { id: recipientId },
    message: { text: messageText },
  };

  console.log("📤 Sending reply:", payload);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  console.log("✅ FB SEND RESULT:", data);
}
