// /api/webhook.js  — final (v2 only + welcome intent router)

const FB_API = "https://graph.facebook.com/v19.0/me/messages";

const BUY_REGEX = new RegExp(
  [
    "buy", "bili", "hanap", "looking", "search",
    "used car", "second hand", "preowned", "pre-owned",
    "financing", "finance", "loan", "downpayment", "dp",
    "cash price", "budget", "all in", "all-in",
    // common PH makes/models & body types
    "vios","mirage","civic","altis","innova","fortuner","montero","terra","xtrail",
    "sedan","suv","hatchback","mpv","van","pickup","truck"
  ].join("|"),
  "i"
);

export default async function handler(req, res) {
  const VERIFY_TOKEN   = process.env.META_VERIFY_TOKEN;
  const PAGE_TOKEN     = process.env.PAGE_ACCESS_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT;
  const WORKFLOW_ID    = process.env.WORKFLOW_ID;
  const CHAT_MODEL     = process.env.OPENAI_MODEL || "gpt-4.1"; // welcome / intent

  const ok  = (d) => res.status(200).json(d ?? { ok: true });
  const err = (c, m) => res.status(c).json({ error: String(m) });

  const sendText = async (recipient_id, text) => {
    try {
      const r = await fetch(`${FB_API}?access_token=${PAGE_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: recipient_id }, message: { text } })
      });
      const j = await r.json().catch(() => ({}));
      console.log("📤 FB SEND:", j);
    } catch (e) {
      console.error("❌ FB send error:", e);
    }
  };

  const softFail = (id) =>
    sendText(id, "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏");

  // ---- Verify webhook (GET) ----
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified");
      return res.status(200).send(challenge);
    }
    return err(403, "Verification failed");
  }

  // ---- Handle events (POST) ----
  if (req.method === "POST") {
    try {
      const body = req.body || {};
      if (body.object !== "page" || !Array.isArray(body.entry)) {
        console.log("ℹ️ Non-page payload:", body);
        return ok({ received: true });
      }

      // Helpers -------------
      const askChat = async (userText) => {
        // Short welcome/intent assistant
        const resp = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Project": OPENAI_PROJECT,
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify({
            model: CHAT_MODEL,
            input: [
              {
                role: "system",
                content:
                  "You are BentaCars Concierge. Be warm and concise in Taglish. " +
                  "If the user seems to be buying/financing a used car, just answer: '__ROUTE_TO_WORKFLOW__'. " +
                  "Else, greet and ask a friendly short clarifier (1 sentence) about whether they want used-car options or financing help."
              },
              { role: "user", content: userText }
            ],
            max_output_tokens: 120
          })
        });

        const raw = await resp.text();
        let json;
        try { json = JSON.parse(raw); } catch { json = null; }

        if (!resp.ok) {
          console.error("❌ Chat error:", raw);
          return null;
        }

        // Responses API: find the first text output
        const textOut =
          json?.output?.[0]?.content?.[0]?.text ??
          json?.output_text ??
          json?.choices?.[0]?.message?.content ??
          null;

        return (typeof textOut === "string") ? textOut.trim() : null;
      };

      const runWorkflowV2 = async (inputText) => {
        const r = await fetch(`https://api.openai.com/v2/workflows/${WORKFLOW_ID}/runs`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Project": OPENAI_PROJECT,
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify({ input: { input_as_text: inputText } })
        });

        const raw = await r.text();
        let j = null;
        try { j = JSON.parse(raw); } catch {}

        if (!r.ok) {
          console.error("❌ OpenAI v2 error:", raw);
          throw new Error(raw);
        }
        return j || raw;
      };

      const extractReply = (wf) => {
        if (!wf) return null;
        if (typeof wf === "string") return wf; // if your workflow returns plain text

        // common Agent Builder shapes
        if (typeof wf.output_text === "string") return wf.output_text;
        if (wf.result && typeof wf.result.output_text === "string") return wf.result.output_text;
        if (wf.output && typeof wf.output.text === "string") return wf.output.text;
        if (wf.output && typeof wf.output.output_text === "string") return wf.output.output_text;

        // last resort: try nested
        const deep =
          wf?.data?.[0]?.content?.[0]?.text?.value ||
          wf?.choices?.[0]?.message?.content ||
          wf?.message;
        return (typeof deep === "string") ? deep : null;
      };
      // ---------------------

      for (const entry of body.entry) {
        for (const ev of entry.messaging || []) {
          const senderId = ev?.sender?.id;
          const text = ev?.message?.text ?? ev?.postback?.payload ?? ev?.postback?.title ?? "";

          if (!senderId) continue;
          if (!text) { await softFail(senderId); continue; }

          console.log("📥 Incoming:", { senderId, text });

          let shouldRoute = BUY_REGEX.test(text);

          // If regex uncertain, ask the tiny concierge to decide (and greet if not route)
          if (!shouldRoute) {
            const concierge = await askChat(text);
            console.log("🤖 Concierge:", concierge);
            if (concierge === "__ROUTE_TO_WORKFLOW__") {
              shouldRoute = true;
            } else if (concierge) {
              await sendText(senderId, concierge);
            } else {
              // fallback welcome if chat failed
              await sendText(
                senderId,
                "Hi! I’m your BentaCars Concierge. Looking for used-car options or financing? Tell me the body type (sedan/SUV/MPV/van/pickup/hatchback) or budget. 😊"
              );
            }
          }

          if (shouldRoute) {
            try {
              const wfRun = await runWorkflowV2(text);
              console.log("🤖 Workflow v2 raw:", JSON.stringify(wfRun).slice(0, 800));
              const reply = extractReply(wfRun) ||
                "Got it! Iche-check ko ang best matches para sa’yo. 😊";
              await sendText(senderId, reply);
            } catch (e) {
              console.error("❌ Workflow v2 failed:", e);
              await softFail(senderId);
            }
          }
        }
      }

      return ok({ delivered: true });
    } catch (e) {
      console.error("❌ Unhandled webhook error:", e);
      return err(500, "Server error");
    }
  }

  return err(404, "Not Found");
}
