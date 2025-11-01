export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT || "";
  const WORKFLOW_ID = process.env.WORKFLOW_ID || "";

  // --- Helpers ---------------------------------------------------------------
  const GREETINGS = [
    "hi","hello","hey","good morning","good afternoon","good evening",
    "yo","kumusta","kamusta","hi po","hello po","hey there"
  ];

  const CAR_KEYWORDS = [
    "vios","mirage","innova","fortuner","sedan","suv","7 seater","7-seater","mpv",
    "unit","kotse","car","financing","installment","downpayment","dp",
    "cash price","bangko","loan","monthly","budget","diesel","gas",
    "used car","pre-owned","2nd hand","sangla","orcr","or/cr"
  ];

  function normalize(t = "") {
    return String(t).toLowerCase().trim();
  }

  function isGreeting(text) {
    const t = normalize(text);
    return GREETINGS.some(g => t === g || t.startsWith(g));
  }

  function isCarIntent(text) {
    const t = normalize(text);
    return CAR_KEYWORDS.some(k => t.includes(k));
  }

  async function sendFbText(recipientId, text) {
    const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
    const payload = {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: { text: text?.slice(0, 1999) || "" }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const j = await safeJson(r);
    console.log("FB SEND RESULT:", j);
    if (!r.ok) {
      throw new Error(`FB Send Error ${r.status}: ${JSON.stringify(j)}`);
    }
    return j;
  }

  async function safeJson(r) {
    try { return await r.json(); } catch { return {}; }
  }

  async function callWorkflow(userText) {
    try {
      const body = {
        // Model must be present for /responses
        model: "gpt-4.1",
        // If a workflow is provided, pass it along. (API accepts 'workflow' object.)
        ...(WORKFLOW_ID ? { workflow: { id: WORKFLOW_ID, version: 2 } } : {}),
        // Standard chat-style input for extra context
        input: [
          { role: "system", content:
            "You are BentaCars Sales AI. Be concise, Taglish. " +
            "If user asks about units/financing/sangla, ask the next best question " +
            "(model/brand/year, OR/CR name, location, budget/monthly, etc.). " +
            "Never show internal JSON. Keep replies 1-2 short bubbles."
          },
          { role: "user", content: userText }
        ]
      };

      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      };
      if (OPENAI_PROJECT) headers["OpenAI-Project"] = OPENAI_PROJECT;

      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });

      const data = await safeJson(r);
      if (!r.ok) {
        console.error("OpenAI error", data);
        return null;
      }

      // Responses API returns either `output_text` or a structured `output`
      const text =
        (data.output_text && String(data.output_text)) ||
        (data.output?.[0]?.content?.[0]?.text?.value) ||
        "";

      return (text || "").trim();
    } catch (err) {
      console.error("Workflow call failed:", err);
      return null;
    }
  }

  // --- Webhook Verification (GET) -------------------------------------------
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified!");
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // --- Incoming Events (POST) -----------------------------------------------
  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      console.log("Incoming webhook event:", JSON.stringify(body, null, 2));

      if (body?.object !== "page" || !Array.isArray(body?.entry)) {
        return res.status(200).send("EVENT_RECEIVED"); // acknowledge anyway
      }

      for (const entry of body.entry) {
        const messagingArr = entry.messaging || [];
        for (const event of messagingArr) {
          // Ignore echoes / delivery / read receipts
          if (event?.message?.is_echo) continue;
          if (event?.delivery || event?.read) continue;

          const senderId = event?.sender?.id;
          const text = event?.message?.text;

          if (!senderId) continue;

          if (!text) {
            // Non-text message
            await sendFbText(senderId, "Sorry, text messages lang muna. 😊");
            continue;
          }

          // ROUTING
          if (isGreeting(text)) {
            console.log("SENT GREETING");
            await sendFbText(
              senderId,
              "Hi! How can I assist you with your car needs today? " +
              "Looking to finance a used car, sell your car for cash, or sangla your OR/CR?"
            );
            continue;
          }

          if (isCarIntent(text)) {
            console.log("TRIGGERED WORKFLOW with text:", text);
            // quick “typing” style acknowledgment
            await sendFbText(senderId, "Thanks! Let me check that for you.");

            const ai = await callWorkflow(text);
            if (ai) {
              await sendFbText(senderId, ai);
            } else {
              await sendFbText(
                senderId,
                "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏"
              );
            }
            continue;
          }

          // Fallback
          console.log("FALLBACK for text:", text);
          await sendFbText(senderId, "Sorry, I didn’t get that. Can you repeat?");
        }
      }

      return res.status(200).send("EVENT_RECEIVED");
    } catch (err) {
      console.error("Webhook handler error:", err);
      return res.status(200).send("EVENT_RECEIVED"); // always 200 to avoid retries loop
    }
  }

  // Not found
  return res.status(404).send("Not Found");
}
