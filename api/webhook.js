// /api/webhook.js
// Node runtime (not Edge). Native fetch.

export default async function handler(req, res) {
  const VERIFY_TOKEN   = process.env.META_VERIFY_TOKEN;
  const PAGE_TOKEN     = process.env.PAGE_ACCESS_TOKEN;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_PROJECT = process.env.OPENAI_PROJECT;
  const WORKFLOW_ID    = process.env.WORKFLOW_ID;

  const ok  = (d) => res.status(200).json(d ?? { ok: true });
  const bad = (c, m) => res.status(c).json({ error: String(m) });

  const sendTyping = async (id) => {
    try {
      await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id }, sender_action: "typing_on" })
      });
    } catch {}
  };

  const sendText = async (id, text) => {
    try {
      const r = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id }, message: { text } })
      });
      const j = await r.json().catch(() => ({}));
      console.log("📤 SEND RESULT:", j);
    } catch (e) {
      console.error("❌ Send message error:", e);
    }
  };

  const softFail = (id) =>
    sendText(id, "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏");

  // ---- VERIFY (GET) ----
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified");
      return res.status(200).send(challenge);
    }
    return bad(403, "Verification failed");
  }

  // ---- PROCESS (POST) ----
  if (req.method === "POST") {
    try {
      const body = req.body || {};
      if (body.object !== "page" || !Array.isArray(body.entry)) {
        console.log("ℹ️ Non-page payload (likely a local test):", body);
        return ok({ received: true });
      }

      // Helper: run the workflow (v2 first, then v1 fallback)
      const runWorkflow = async (inputText) => {
        const commonHeaders = {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Project": OPENAI_PROJECT
        };

        // v2 call
        let resp = await fetch(`https://api.openai.com/v2/workflows/${WORKFLOW_ID}/runs`, {
          method: "POST",
          headers: commonHeaders,
          body: JSON.stringify({ input: { input_as_text: inputText } })
        });

        let raw = await resp.text();
        let jsonV2 = null;
        try { jsonV2 = JSON.parse(raw); } catch {}

        if (resp.ok) {
          return { version: "v2", data: jsonV2 ?? raw };
        }

        // If invalid URL or not found, try v1
        const invalidUrl =
          !resp.ok &&
          (resp.status === 404 ||
           (jsonV2 && jsonV2.error && /invalid url/i.test(jsonV2.error.message || "")));

        if (!invalidUrl) {
          // Some other v2 error → bubble up
          throw new Error(`OpenAI v2 error: ${raw}`);
        }

        // v1 fallback
        resp = await fetch(`https://api.openai.com/v1/workflows/${WORKFLOW_ID}/runs`, {
          method: "POST",
          headers: commonHeaders,
          body: JSON.stringify({ input: { input_as_text: inputText } })
        });

        raw = await resp.text();
        let jsonV1 = null;
        try { jsonV1 = JSON.parse(raw); } catch {}

        if (!resp.ok) throw new Error(`OpenAI v1 error: ${raw}`);
        return { version: "v1", data: jsonV1 ?? raw };
      };

      // Helper: extract a reply string from any workflow shape
      const extractReply = (wf) => {
        if (!wf || typeof wf !== "object") return null;

        // Common shapes from Agent Builder returns
        // direct
        if (typeof wf.output_text === "string") return wf.output_text;
        if (wf.result && typeof wf.result.output_text === "string") return wf.result.output_text;

        // v2 run objects may wrap output
        if (wf.output && typeof wf.output.text === "string") return wf.output.text;
        if (wf.output && typeof wf.output.output_text === "string") return wf.output.output_text;

        // Sometimes under data/content
        const tryDeep =
          wf?.data?.[0]?.content?.[0]?.text?.value ||
          wf?.choices?.[0]?.message?.content ||
          wf?.message;

        if (typeof tryDeep === "string") return tryDeep;

        return null;
      };

      for (const entry of body.entry) {
        for (const ev of entry.messaging || []) {
          const senderId =
            ev?.sender?.id ||
            ev?.recipient?.user_ref || // very rare alt
            null;

          const text =
            ev?.message?.text ??
            ev?.postback?.payload ??
            ev?.postback?.title ??
            "";

          if (!senderId) continue;
          if (!text || typeof text !== "string") {
            await softFail(senderId);
            continue;
          }

          console.log("📥 Incoming:", { senderId, text });
          await sendTyping(senderId);

          let wfRun;
          try {
            wfRun = await runWorkflow(text);
          } catch (err) {
            console.error("❌ OpenAI call failed:", err);
            await softFail(senderId);
            continue;
          }

          console.log(`🤖 Workflow (${wfRun.version}) raw:`, JSON.stringify(wfRun.data).slice(0, 600));

          const reply = extractReply(wfRun.data);
          if (!reply || typeof reply !== "string") {
            await softFail(senderId);
            continue;
          }

          await sendText(senderId, reply);
        }
      }

      return ok({ delivered: true });
    } catch (e) {
      console.error("❌ Unhandled webhook error:", e);
      return bad(500, "Server error");
    }
  }

  return bad(404, "Not Found");
}
