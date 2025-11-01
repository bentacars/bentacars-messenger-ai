import { NextResponse } from "next/server";

/**
 * ✅ Facebook Page Access Token + Verify Token (from Vercel env)
 * ✅ OpenAI API Key + Workflow ID (from Vercel env)
 */
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WORKFLOW_ID = process.env.WORKFLOW_ID;

/**
 * ✅ FACEBOOK SEND MESSAGE FUNCTION
 */
async function sendMessageToMessenger(recipientId, text) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const payload = {
    recipient: { id: recipientId },
    message: { text },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  console.log("🔵 META SEND RESULT:", result);
  return result;
}

/**
 * ✅ CALL OPENAI (AGENT WORKFLOW) — not normal GPT chat
 */
async function callAgentWorkflow(userInput) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Project": process.env.OPENAI_PROJECT,
    },
    body: JSON.stringify({
      model: WORKFLOW_ID, // ✅ your workflow id
      input: userInput,
    }),
  });

  const data = await response.json();
  console.log("🟣 OPENAI RAW:", data);

  // Extract reply safely
  const reply =
    data.output_text ??
    data.output?.[0]?.content?.[0]?.text ??
    "Sorry, I couldn’t process that.";

  return reply;
}

/**
 * ✅ WEBHOOK GET — FACEBOOK VERIFICATION
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("✅ WEBHOOK VERIFIED SUCCESSFULLY");
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

/**
 * ✅ WEBHOOK POST — HANDLE REAL MESSAGES
 */
export async function POST(request) {
  try {
    const body = await request.json();
    console.log("📩 WEBHOOK RECEIVED:", JSON.stringify(body, null, 2));

    // Safety check
    if (!body.entry || !body.entry[0].messaging) {
      console.log("⚠️ No messaging event detected");
      return NextResponse.json({ status: "ignored" }, { status: 200 });
    }

    const webhookEvent = body.entry[0].messaging[0];
    const senderId = webhookEvent.sender.id;

    // ✅ Handle text message
    if (webhookEvent.message && webhookEvent.message.text) {
      const userMessage = webhookEvent.message.text;
      console.log("🟡 USER MESSAGE:", userMessage);

      // Call OpenAI Workflow
      const aiResponse = await callAgentWorkflow(userMessage);
      console.log("🟢 AI RESPONSE:", aiResponse);

      // Send result back to Messenger
      await sendMessageToMessenger(senderId, aiResponse);

      return NextResponse.json({ status: "ok" }, { status: 200 });
    }

    return NextResponse.json({ status: "no_message" }, { status: 200 });
  } catch (err) {
    console.error("❌ WEBHOOK ERROR:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
