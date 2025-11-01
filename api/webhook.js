// api/webhook.js
export default async function handler(req, res) {
  // --- ALWAYS LOG THE HIT ---
  console.log("WEBHOOK HIT", {
    method: req.method,
    url: req.url,
    query: req.query,
    headers: {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
      "x-hub-signature-256": req.headers["x-hub-signature-256"] || null,
    },
  });

  if (req.method === "GET") {
    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
    const { ["hub.mode"]: mode, ["hub.verify_token"]: token, ["hub.challenge"]: challenge } = req.query;

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verify: success");
      return res.status(200).send(challenge);
    }
    console.warn("Webhook verify: failed", { mode, tokenOK: !!token });
    return res.sendStatus(403);
  }

  if (req.method === "POST") {
    try {
      console.log("WEBHOOK BODY RAW:", JSON.stringify(req.body, null, 2));

      // Basic router (optional)
      if (req.body?.object === "page") {
        for (const entry of req.body.entry || []) {
          for (const ev of entry.messaging || []) {
            if (ev.message)   console.log("MESSAGE EVENT:", JSON.stringify(ev.message, null, 2));
            if (ev.postback)  console.log("POSTBACK EVENT:", JSON.stringify(ev.postback, null, 2));
          }
        }
      }

      // Always 200 to stop Meta retries
      return res.status(200).send("EVENT_RECEIVED");
    } catch (e) {
      console.error("POST handler error:", e);
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(404).send("Not Found");
}
