export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

  // ✅ Log every request for debugging
  console.log("📩 Incoming request:", {
    method: req.method,
    body: req.body,
    query: req.query,
    headers: req.headers,
  });

  // ✅ Handle Meta Webhook Verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ WEBHOOK VERIFIED");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }

  // ✅ Handle Incoming Events (POST)
  if (req.method === "POST") {
    console.log("✅ WEBHOOK POST RECEIVED:", JSON.stringify(req.body, null, 2));

    // Always reply 200 OK so Meta stops retrying
    return res.status(200).send("EVENT_RECEIVED");
  }

  // ❌ Any other request = Not Found
  return res.status(404).send("Not Found");
}
