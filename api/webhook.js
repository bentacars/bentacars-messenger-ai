export default async function handler(req, res) {
  const VERIFY_TOKEN   = process.env.META_VERIFY_TOKEN;
  const PAGE_TOKEN     = process.env.PAGE_ACCESS_TOKEN;
  const OPENAI_KEY     = process.env.OPENAI_API_KEY;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT || undefined; // optional
  const WORKFLOW_ID    = process.env.WORKFLOW_ID || "";           // Agent Builder workflow id (optional)
  const OPENAI_BASE    = "https://api.openai.com";

  // --- Helpers ---------------------------------------------------------------
  const log = (...args) => console.log(...args);

  const sendToMessenger = async (recipientId, text) => {
    const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
    const body = {
      recipient: { id: recipientId },
      message: { text }
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const jr = await r.json().catch(() => ({}));
    log("↳ SEND RESULT:", { recipient_id: jr.recipient_id, message_id: jr.message_id });
    return jr;
  };

  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))
    ]);

  // OpenAI call: prefers Agent Builder WORKFLOW (Responses API), else plain model
  const callOpenAI = async (userText) => {
    try {
      if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY missing");

      if (WORKFLOW_ID) {
        // Use Responses API with a workflow input
        const body = {
          // IMPORTANT: the schema for workflow inputs uses "input" (string) and "workflow" object.
          // We pass the workflow id via the new "input" envelope with metadata.
          // If your account has the Agents SDK, you can also hit the /v1/workflows/{id}/runs endpoint.
          input: [
            { role: "user", content: [{ type: "input_text", text: userText }] }
          ],
          // Hint to the backend about the workflow we want to run:
          metadata: { workflow_id: WORKFLOW_ID },
          // We only need text out
          modalities: ["text"]
        };

        const r = await withTimeout(
          fetch(`${OPENAI_BASE}/v1/responses`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${OPENAI_KEY}`,
              ...(OPENAI_PROJECT ? { "OpenAI-Project": OPENAI_PROJECT } : {}),
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          }),
          8000
        );

        const data = await r.json();
        log("OpenAI workflow resp:", JSON.stringify(data).slice(0, 800));

        // Extract first text output safely
        const out = data?.output?.[0]?.content?.find?.(c => c.type === "output_text")?.text
                 || data?.output_text
                 || data?.response?.output_text
                 || null;

        if (!out) throw new Error("No output_text from workflow");
        return String(out);
      } else {
        // Fallback: direct model (simple Chat → Responses API)
        const r = await withTimeout(
          fetch(`${OPENAI_BASE}/v1/responses`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${OPENAI_KEY}`,
              ...(OPENAI_PROJECT ? { "OpenAI-Project": OPENAI_PROJECT } : {}),
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "gpt-4.1-mini",
              input: [
                {
                  role: "system",
                  content: "You are BentaCars Consultant. Reply in short, natural Taglish. If the user asks about a specific model, acknowledge and ask 1 follow-up (body type or budget)."
                },
                { role: "user", content: userText }
              ],
              modalities: ["text"]
            })
          }),
          8000
        );
        const data = await r.json();
        log("OpenAI simple resp:", JSON.stringify(data).slice(0, 800));

        const out = data?.output?.[0]?.content?.find?.(c => c.type === "output_text")?.text
                 || data?.output_text
                 || null;
        if (!out) throw new Error("No output_text from model");
        return String(out);
      }
    } catch (err) {
      log("OpenAI ERROR:", err?.message || err);
      return null;
    }
  };

  // --- Webhook Verification (GET) -------------------------------------------
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      log("✅ Webhook verify: success");
      return res.status(200).send(challenge);
    }
    log("❌ Webhook verify failed");
    return res.sendStatus(403);
  }

  // --- Incoming Events (POST) -----------------------------------------------
  if (req.method === "POST") {
    try {
      const body = req.body;
      // v24 format: { object: 'page', entry: [ { messaging: [ ... ] } ] }
      if (body?.object !== "page" || !Array.isArray(body.entry)) {
        log("Ignoring non-page payload");
        return res.sendStatus(200);
      }

      // Process each messaging event (FB batches them)
      for (const entry of body.entry) {
        const events = entry.messaging || [];
        for (const event of events) {
          const senderId = event?.sender?.id;
          const postback  = event?.postback?.payload;
          const text      = event?.message?.text?.trim();

          if (!senderId) continue;

          // 1) Immediate ack so user sees activity
          const ack = "Thanks! Let me check that for you.";
          await sendToMessenger(senderId, ack);

          let userText = text || postback || "";
          log("Incoming:", { senderId, text: userText });

          // If nothing meaningful, continue
          if (!userText) continue;

          // 2) Call OpenAI (workflow if provided → else fallback model)
          const aiReply = await callOpenAI(userText);

          // 3) Send result or graceful fallback
          const safeReply =
            aiReply ||
            "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏";

          await sendToMessenger(senderId, safeReply);
        }
      }

      return res.sendStatus(200);
    } catch (e) {
      log("Handler ERROR:", e?.message || e);
      return res.sendStatus(200); // Never let Meta retry-storm
    }
  }

  // --- Others ---------------------------------------------------------------
  return res.status(404).send("Not Found");
}
