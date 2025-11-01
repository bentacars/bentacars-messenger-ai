export default async function handler(req, res) {
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const WORKFLOW_ID = process.env.WORKFLOW_ID;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT;

  // 1️⃣ VERIFY WEBHOOK (FB REQUIRED)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ WEBHOOK VERIFIED");
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send("Forbidden");
    }
  }

  // 2️⃣ HANDLE INCOMING MESSAGES
  if (req.method === "POST") {
    try {
      const body = req.body;

      if (!body.object || body.object !== "page") {
        return res.status(200).send("ignored");
      }

      const entry = body.entry?.[0];
      const messaging = entry.messaging?.[0];
      const senderId = messaging?.sender?.id;
      const text = messaging?.message?.text;

      if (!senderId || !text) {
        console.log("⚠️ No sender/text received");
        return res.status(200).send("no_action");
      }

      console.log("📩 Incoming:", senderId, text);

      // 3️⃣ CALL OPENAI WORKFLOW ✅ (MODEL FIXED)
      const aiResponse = await fetch(
        `https://api.openai.com/v1/projects/${OPENAI_PROJECT}/workflows/${WORKFLOW_ID}/runs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4.1",   // ✅ REQUIRED or OpenAI rejects request
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: text
                  }
                ]
              }
            ]
          })
        }
      );

      const aiResult = await aiResponse.json();
      console.log("🤖 AI RAW RESULT:", aiResult);

      const replyText =
        aiResult?.output_text ||
        "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏";

      console.log("✅ Final reply:", replyText);

      // 4️⃣ SEND BACK TO FACEBOOK USER
      await fetch(
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

      return res.status(200).send("ok");
    } catch (err) {
      console.error("❌ Webhook ERROR:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).send("Method Not Allowed");
}
