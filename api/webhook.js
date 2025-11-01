// api/webhook.js
// Vercel Node.js (ESM). package.json has: { "type": "module" }

export default async function handler(req, res) {
  // 1) WEBHOOK VERIFICATION (Meta calls this with GET)
  if (req.method === "GET") {
    try {
      const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
        console.log("Webhook verify: success");
        // Must return the challenge string to verify
        return res.status(200).send(challenge);
      }

      console.warn("Webhook verify: failed", { mode, tokenPresent: !!token });
      return res.sendStatus(403);
    } catch (err) {
      console.error("Webhook verify error:", err);
      return res.sendStatus(500);
    }
  }

  // 2) INCOMING EVENTS (Meta posts here)
  if (req.method === "POST") {
    try {
      // Be very loud so it shows in Vercel logs
      console.log("WEBHOOK POST HIT", {
        method: req.method,
        path: req.url,
        query: req.query,
        headers: {
          "content-type": req.headers["content-type"],
          "user-agent": req.headers["user-agent"],
          "x-hub-signature-256": req.headers["x-hub-signature-256"] || null,
        },
      });

      // Body is already parsed by Vercel’s Node runtime
      console.log("WEBHOOK BODY:", JSON.stringify(req.body, null, 2));

      // OPTIONAL: basic router for messages and postbacks (no-op for now)
      if (req.body && req.body.object === "page" && Array.isArray(req.body.entry)) {
        for (const entry of req.body.entry) {
          const events = entry.messaging || [];
          for (const ev of events) {
            if (ev.message) {
              console.log("MESSAGE EVENT:", JSON.stringify(ev.message, null, 2));
              // TODO: forward to OpenAI / your agent here
            } else if (ev.postback) {
              console.log("POSTBACK EVENT:", JSON.stringify(ev.postback, null, 2));
              // TODO: handle postbacks
            } else {
              console.log("OTHER EVENT:", JSON.stringify(ev, null, 2));
            }
          }
        }
      }

      // Always 200 so Meta stops retrying
      return res.status(200).send("EVENT_RECEIVED");
    } catch (err) {
      console.error("Webhook POST error:", err);
      // Still 200 — prevents Meta retry storms while you debug
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  // 3) ANYTHING ELSE
  return res.status(404).send("Not Found");
}
