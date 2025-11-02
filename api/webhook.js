// api/webhook.js
// Vercel (Node runtime)
export const config = { runtime: "nodejs" };

// We use only REST for Workflows v2 to avoid SDK version issues.
// Keep this file self-contained and simple.

const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || "";
const WORKFLOW_ID = process.env.WORKFLOW_ID;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

// -------- Helpers --------
async function fbSendText(recipientId, text) {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(
    PAGE_TOKEN
  )}`;

  const body = {
    recipient: { id: recipientId },
    message: { text },
    messaging_type: "RESPONSE",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.text();
  if (!res.ok) {
    console.error("❌ FB SEND error:", res.status, data);
    return { ok: false, status: res.status, data };
  }
  console.log("✅ FB SEND:", data);
  return { ok: true };
}

// A very light welcome using Chat Completions (REST), so no SDK needed.
async function getWelcomeReply(userText) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
        ...(OPENAI_PROJECT ? { "OpenAI-Project": OPENAI_PROJECT } : {}),
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "You are BentaCars Concierge. Be brief, warm, and Taglish. If user seems interested in used cars or financing, invite them to share body type and city. Keep it conversational, not robotic.",
          },
          { role: "user", content: userText || "Hi" },
        ],
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error("❌ OpenAI chat error:", res.status, txt);
      return "Hi po! Welcome sa BentaCars 😊 How can we help today?";
    }
    const json = await res.json();
    const content =
      json?.choices?.[0]?.message?.content?.trim() ||
      "Hi po! Welcome sa BentaCars 😊 Interested ba kayo sa used car options or financing?";
    return content;
  } catch (err) {
    console.error("❌ getWelcomeReply error:", err);
    return "Hi po! Welcome sa BentaCars 😊 How can we help today?";
  }
}

// Car-intent regex
const USED_CAR_REGEX =
  /\b(buy|looking|hanap|bili|kuha|used\s*car|second[-\s]?hand|preowned|mirage|vios|fortuner|innova|civic|city|avanza|xpander|hilux|ranger|navara|montero|terra|loan|financ(?:e|ing)|dp|down\s*payment)\b/i;

// Call Workflows v2 (REST)
async function runWorkflowV2(inputText) {
  if (!WORKFLOW_ID) {
    console.error("❌ Missing WORKFLOW_ID env.");
    return "Nagka-issue sa setup. Paki-try ulit in a bit. 🙏";
  }
  try {
    const res = await fetch("https://api.openai.com/v1/workflows/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "workflows=v2", // REQUIRED to use v2
        ...(OPENAI_PROJECT ? { "OpenAI-Project": OPENAI_PROJECT } : {}),
      },
      body: JSON.stringify({
        workflow_id: WORKFLOW_ID,
        input: { input_as_text: inputText },
        // If your AB is set to version=1 or version=2 internally, you generally
        // don't need to pass "version" here. If you want to force, uncomment:
        // version: "2",
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      console.error("❌ Workflow v2 HTTP error:", res.status, raw);
      return "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏";
    }

    const run = JSON.parse(raw);

    // Try the common shapes AB returns:
    // 1) Single text in output[0].content[0].text (type could be "output_text" or "text")
    const out0 = run?.output?.[0];
    const c0 = out0?.content?.[0];
    const directText =
      c0?.type === "output_text" ? c0?.text :
      c0?.type === "text" ? c0?.text : null;

    if (typeof directText === "string" && directText.trim()) {
      return directText.trim();
    }

    // 2) If your workflow returns a JSON object with { message: "..." }
    const jsonPart = out0?.content?.find?.((c) => c?.type === "json")?.json;
    if (jsonPart?.message && typeof jsonPart.message === "string") {
      return jsonPart.message.trim();
    }

    // Fallback
    console.warn("⚠️ Unrecognized workflow output shape (showing first 800 chars):", JSON.stringify(run).slice(0, 800));
    return "Thanks! Iche-check ko muna ang best matches para sa inyo. 🚗";
  } catch (err) {
    console.error("❌ Workflow v2 failed:", err);
    return "Medyo nagka-issue sa processing. Paki-try ulit mamaya. 🙏";
  }
}

// -------- Main webhook handler --------
export default async function handler(req, res) {
  try {
    // GET: Verify webhook
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verify OK");
        res.status(200).send(challenge);
      } else {
        console.warn("❌ Webhook verify failed");
        res.status(403).send("Forbidden");
      }
      return;
    }

    // POST: Events
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const body = req.body || {};
    const payload = typeof body === "string" ? JSON.parse(body) : body;

    if (!payload?.entry?.length) {
      console.warn("⚠️ No entries in payload");
      res.status(200).send("EVENT_RECEIVED");
      return;
    }

    for (const entry of payload.entry) {
      const messagings = entry?.messaging || [];
      for (const m of messagings) {
        // Skip echoes (prevents loops)
        if (m?.message?.is_echo) continue;

        const senderId = m?.sender?.id;
        const text = m?.message?.text?.trim();

        if (!senderId || !text) continue;

        console.log("🟢 Incoming:", { senderId, text });

        // 1) Always welcome first (simple LLm)
        const welcome = await getWelcomeReply(text);
        await fbSendText(senderId, welcome);

        // 2) If intent looks like car/financing → run workflow v2
        if (USED_CAR_REGEX.test(text)) {
          await fbSendText(
            senderId,
            "Salamat! Iche-check ko muna ang best options based sa gusto ninyo. ⏳"
          );

          const wfReply = await runWorkflowV2(text);
          await fbSendText(senderId, wfReply);
        }
      }
    }

    // Always respond 200 to Meta
    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("❌ Webhook fatal error:", err);
    // Still acknowledge to keep Meta happy
    res.status(200).send("EVENT_RECEIVED");
  }
}
