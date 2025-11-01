// /api/webhook.js
// Vercel Node runtime (NOT Edge). Uses native fetch in Node 18+

export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT;
  const WORKFLOW_ID = process.env.WORKFLOW_ID;

  // --- Small helpers --------------------------------------------------------
  const ok = (data) => res.status(200).json(data ?? { ok: true });
  const bad = (code, msg) => res.status(code).json({ error: String(msg) });

  const sendTyping = async (recipientId) => {
    try {
      await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          sender_action: "typing_on",
        }),
      });
    } catch (e) {
      console.error("Typing indicator failed:", e);
    }
  };

  const sendText = async (recipientId, text) => {
    try {
      const r = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text },
        }),
      });
      const j = await r.json().catch(() => ({}));
      console.log("📤 SEND RESULT:", j);
    } catch (e) {
      console.error("❌ Send message error:", e);
    }
  };

  const politeFail = async (recipientId) =>
    sendText(
      recipientId,
      "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏"
    );

  // --- 1) Webhook VERIFY (GET) ----------------------------------------------
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified!");
      res.status(200).send(challenge);
      return;
    }
    return bad(403, "Verification failed");
  }

  // --- 2) Incoming events (POST) --------------------------------------------
  if (req.method === "POST") {
    try {
      const body = req.body || {};
      // Facebook Messenger delivers {object:'page', entry:[{ messaging: [...] }]}
      if (body.object !== "page" || !Array.isArray(body.entry)) {
        // Allow local curl tests that send plain {message:"hi"} shape
        console.log("ℹ️ Non-standard payload (likely test):", JSON.stringify(body));
        return ok({ received: true });
      }

      for (const entry of body.entry) {
        const messagingEvents = entry.messaging || [];
        for (const event of messagingEvents) {
          const senderId = event?.sender?.id;
          const text =
            event?.message?.text ??
            event?.postback?.title ??
            event?.postback?.payload ??
            "";

          if (!senderId) continue;

          // Skip if nothing to process
          if (!text || typeof text !== "string") {
            await politeFail(senderId);
            continue;
          }

          console.log("📥 Incoming:", { senderId, text });

          // Send typing indicator
          await sendTyping(senderId);

          // --- Call OpenAI Workflows (CORRECT, ABSOLUTE URL) -----------------
          const oaResponse = await fetch(
            `https://api.openai.com/v1/workflows/${WORKFLOW_ID}/runs`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Project": OPENAI_PROJECT,
              },
              body: JSON.stringify({
                // Your workflow expects { input_as_text: "..." }
                input: { input_as_text: text },
                // Some workflows also accept model; harmless to include.
                model: "gpt-4.1",
              }),
            }
          );

          // If OpenAI returns HTML (e.g., wrong URL), avoid JSON.parse crash
          const raw = await oaResponse.text();
          let wf;
          try {
            wf = JSON.parse(raw);
          } catch (e) {
            console.error("❌ Webhook error: OpenAI returned non-JSON:", raw.slice(0, 200));
            await politeFail(senderId);
            continue;
          }

          if (!oaResponse.ok) {
            console.error("❌ OpenAI returned error:", wf);
            await politeFail(senderId);
            continue;
          }

          // --- Extract the workflow's reply text safely ----------------------
          // Your Agent Builder workflow returns an object shaped like either:
          //  A) { output_text: "..." }
          //  B) { result: { output_text: "..." } }
          //  C) { output: { text: "..." } }
          //  D) fallback to something inside arrays if present
          const replyText =
            wf?.output_text ||
            wf?.result?.output_text ||
            wf?.output?.text ||
            wf?.data?.[0]?.content?.[0]?.text?.value ||
            wf?.message ||
            null;

          console.log("🤖 Workflow output (raw):", JSON.stringify(wf).slice(0, 500));
          console.log("📝 Resolved reply text:", replyText);

          if (!replyText || typeof replyText !== "string") {
            await politeFail(senderId);
            continue;
          }

          // --- Send back to Messenger ---------------------------------------
          await sendText(senderId, replyText);
        }
      }

      return ok({ delivered: true });
    } catch (err) {
      console.error("❌ Unhandled webhook error:", err);
      return bad(500, "Server error");
    }
  }

  // --- Others ---------------------------------------------------------------
  return bad(404, "Not Found");
}
