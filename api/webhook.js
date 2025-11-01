export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

  // ✅ Handle Webhook Verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified!");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }

  // ✅ Handle Incoming Webhook Events (POST)
  if (req.method === "POST") {
    console.log("📩 Incoming webhook event:", JSON.stringify(req.body, null, 2));

    // Respond immediately so Meta stops retrying
    res.status(200).send("EVENT_RECEIVED");

    // TODO: next step — forward the message to OpenAI agent or logic handler here

    return;
  }

  return res.status(404).send("Not Found");
}
