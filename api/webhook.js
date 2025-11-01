// /api/webhook.js
// ✅ Full working webhook for Facebook Messenger + OpenAI Workflows
// Requires the following ENV variables configured in Vercel:
// - OPENAI_API_KEY
// - OPENAI_PROJECT
// - WORKFLOW_ID
// - PAGE_ACCESS_TOKEN
// - META_VERIFY_TOKEN

export default async function handler(req, res) {
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const WORKFLOW_ID = process.env.WORKFLOW_ID;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT;

  if (!PAGE_ACCESS_TOKEN || !VERIFY_TOKEN || !WORKFLOW_ID || !OPENAI_API_KEY || !OPENAI_PROJECT) {
    console.error("❌ Missing required environment variables");
    return res.status(500).send("Server Misconfigured: Missing ENV");
  }

  // 🔍 GET Request: Facebook webhook verification
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified successfully");
      return res.status(200).send(challenge);
    } else {
      console.warn("❌ Webhook verification failed");
      return res.status(403).send("Verification failed");
    }
  }

  // 📩 POST Request: Facebook sends user messages here
  if (req.method === "POST") {
    try {
      const body = req.body;

      if (body.object !== "page") return res.status(200).send("Not a page event");

      const messagingEvent = body.entry?.[0]?.messaging?.[0];
      const senderId = messagingEvent?.sender?.id;
      const incomingText = messagingEvent?.message?.text;

      if (!senderId || !incomingText) {
        console.error("⚠️ Missing sender or text in FB webhook");
        return res.status(200).send("No actionable message");
      }

      console.log("📥 Incoming message:", { senderId, incomingText });

      // 🚀 CALL YOUR OPENAI WORKFLOW
      const oaResponse = await fetch(`https://api.openai.com/v1/workflows/${WORKFLOW_ID}/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Project": OPENAI_PROJECT
        },
        body: JSON.stringify({
          model: "gpt-4.1",            // ALWAYS required when invoking workflows
          input: { input_as_text: incomingText }
        })
      });

      const rawResponse = await oaResponse.text();
      let parsedResponse;

      try {
        parsedResponse = JSON.parse(rawResponse);
      } catch (err) {
        console.error("❌ OpenAI returned non-JSON:\n", rawResponse);
        throw new Error("OpenAI response was not JSON");
      }

      if (!oaResponse.ok) {
        console.error("❌ OpenAI returned error:", parsedResponse);
        throw new Error(parsedResponse?.error?.message || "OpenAI workflow failed");
      }

      console.log("🤖 OpenAI Workflow Output:", parsedResponse);

      const replyText =
        parsedResponse?.output_text ||
        parsedResponse?.run?.output_text ||
        parsedResponse?.result?.output_text ||
        "Medyo nagka-issue sa processing. Can you try again? 🙏";

      // 📤 Send message back to user in Messenger
      const fbSendResult = await fetch(
        `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { id: senderId },
            message: { text: replyText }
          })
        }
      );

      if (!fbSendResult.ok) {
        const fbErr = await fbSendResult.text();
        console.error("❌ FB send failed:", fbErr);
      } else {
        console.log("✅ Message sent to user:", replyText);
      }

      return res.status(200).send("ok");
    } catch (error) {
      console.error("❌ Webhook error:", error);
      return res.status(500).json({ error: error.message || error.toString() });
    }
  }

  // ❌ Invalid request method
  return res.status(405).send("Method Not Allowed");
}
