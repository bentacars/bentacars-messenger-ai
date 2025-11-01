// /api/webhook.js
export default async function handler(req, res) {
  try {
    const VERIFY_TOKEN     = process.env.META_VERIFY_TOKEN;
    const PAGE_ACCESS_TOKEN= process.env.PAGE_ACCESS_TOKEN;
    const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
    const OPENAI_PROJECT   = process.env.OPENAI_PROJECT;   // Optional but recommended
    const WORKFLOW_ID      = process.env.WORKFLOW_ID;      // wf_... from Agent Builder

    // --- 1) VERIFY CALLBACK (GET) ---
    if (req.method === "GET") {
      const mode      = req.query["hub.mode"];
      const token     = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified!");
        return res.status(200).send(challenge);
      }
      return res.status(403).send("Forbidden");
    }

    // --- 2) HANDLE EVENTS (POST) ---
    if (req.method === "POST") {
      const body = req.body;
      console.log("Incoming webhook event:", JSON.stringify(body, null, 2));

      if (body.object !== "page" || !Array.isArray(body.entry)) {
        return res.status(200).send("EVENT_RECEIVED"); // acknowledge even if not a page event
      }

      // Process each messaging event
      for (const entry of body.entry) {
        const messaging = entry.messaging || [];
        for (const event of messaging) {
          const senderId = event.sender?.id;
          const pageId   = event.recipient?.id;

          // Only proceed if we have a sender (a human user)
          if (!senderId) continue;

          // Extract text either from a regular message or a postback
          const isTextEvent = !!event.message?.text;
          const isPostback  = !!event.postback?.payload;

          const inputText =
            (isTextEvent && event.message.text) ||
            (isPostback && event.postback.payload) ||
            "";

          // 2a. Show typing and send a short ack immediately
          await sendTyping(PAGE_ACCESS_TOKEN, senderId, true);
          await sendText(PAGE_ACCESS_TOKEN, senderId, "Thanks! Let me check that for you.");

          if (!inputText) {
            await sendText(PAGE_ACCESS_TOKEN, senderId,
              "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏");
            continue;
          }

          // 2b. Call your Agent Builder WORKFLOW through Responses API
          let aiReply = null;
          try {
            const resp = await fetch("https://api.openai.com/v1/responses", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json",
                ...(OPENAI_PROJECT ? { "OpenAI-Project": OPENAI_PROJECT } : {})
              },
              body: JSON.stringify({
                // ✅ Correct field name:
                workflow_id: WORKFLOW_ID,
                input: [
                  { role: "user", content: [{ type: "input_text", text: inputText }] }
                ]
              })
            });

            const json = await resp.json();
            if (!resp.ok) {
              console.error("OpenAI error:", JSON.stringify(json, null, 2));
              throw new Error(json?.error?.message || "OpenAI request failed");
            }

            // Try to extract a plain text reply in a few robust ways
            aiReply =
              json.output_text ||
              json.output?.[0]?.content?.map(c => c?.text).filter(Boolean).join("\n") ||
              json.output?.[0]?.content?.[0]?.text ||
              null;

          } catch (err) {
            console.error("OpenAI call failed:", err);
          }

          // 2c. Fall back message if we didn't get something usable
          if (!aiReply || typeof aiReply !== "string") {
            aiReply = "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏";
          }

          // 2d. Send the AI reply back to the user
          console.log("REPLYING BACK:", JSON.stringify({ recipient_id: senderId, message: aiReply }));
          await sendText(PAGE_ACCESS_TOKEN, senderId, aiReply);
          await sendTyping(PAGE_ACCESS_TOKEN, senderId, false);
        }
      }

      return res.status(200).send("EVENT_RECEIVED");
    }

    return res.status(404).send("Not Found");
  } catch (e) {
    console.error("Webhook fatal:", e);
    return res.status(500).send("Server error");
  }
}

/* ---------------- Messenger helpers ---------------- */

async function sendTyping(token, psid, on = true) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        sender_action: on ? "typing_on" : "typing_off"
      })
    });
  } catch (e) {
    console.error("typing error:", e);
  }
}

async function sendText(token, psid, text) {
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        message: { text }
      })
    });
    const j = await r.json();
    if (!r.ok) console.error("sendText FAIL:", j);
    else       console.log("SEND RESULT:", j);
  } catch (e) {
    console.error("sendText error:", e);
  }
}
