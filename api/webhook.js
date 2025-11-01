// api/webhook.js
// Messenger webhook -> OpenAI Workflows v2 via fetch (no /v1), with echo-filter + debounce

const META_GRAPH_URL = "https://graph.facebook.com/v19.0";

const VERIFY_TOKEN       = process.env.META_VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN  = process.env.PAGE_ACCESS_TOKEN;

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT     = process.env.OPENAI_PROJECT || "";   // optional
const WORKFLOW_ID        = (process.env.WORKFLOW_ID || "").trim(); // wf_...

function json(res, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sendFBText(psid, text) {
  // simple debounce per user (4s)
  const now = Date.now();
  const map = sendFBText._map || (sendFBText._map = new Map());
  const last = map.get(psid) || 0;
  if (now - last < 4000) {
    console.log("Debounced duplicate reply to", psid);
    return;
  }
  map.set(psid, now);

  const body = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { text },
  };
  const r = await fetch(`${META_GRAPH_URL}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text().catch(() => "");
  console.log("FB SEND:", r.ok ? "OK" : "FAIL", txt);
}

function isGreeting(t) {
  const s = (t || "").toLowerCase();
  return /\b(hi|hello|hey|kumusta|good\s*(am|pm|day)|gud\s*(am|pm))\b/.test(s);
}
function isUsedCarIntent(t) {
  const s = (t || "").toLowerCase();
  return [
    "used car","used-car","buy","hanap","looking for","options",
    "financing","installment","loan","dp","downpayment","all in","all-in",
    "sedan","suv","mpv","van","hatchback","pickup",
    "vios","mirage","fortuner","innova","terra","carnival"
  ].some(k => s.includes(k));
}

/** ---- Workflows v2 via fetch (no /v1) ---- */
async function runWorkflowV2(inputText) {
  if (!WORKFLOW_ID || !WORKFLOW_ID.startsWith("wf_")) {
    throw new Error("WORKFLOW_ID missing/invalid");
  }
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const url = `https://api.openai.com/workflows/${WORKFLOW_ID}/runs`; // <-- NO /v1
  const headers = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "workflows=v2",
  };
  if (OPENAI_PROJECT) headers["OpenAI-Project"] = OPENAI_PROJECT;

  const payload = { inputs: { input_as_text: inputText } };

  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });

  // If the API returns HTML (nginx/404), throw a readable error
  const text = await resp.text();
  if (!resp.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || text;
    } catch (_) { /* text was not JSON */ }
    throw new Error(`Workflows v2 HTTP ${resp.status}: ${msg}`);
  }

  // Parse JSON body
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error("Workflows v2: Response was not JSON");
  }

  // Try common locations for a usable message
  const candidates = [
    data.output_text,
    data.message,
    data.response?.outputs?.[0]?.content?.[0]?.text,
    data.outputs?.[0]?.content?.[0]?.text,
  ];
  const msg = candidates.find(x => typeof x === "string" && x.trim())?.trim();
  return msg || "Salamat! Iche-check ko ang best options para sa inyo. ⏳";
}

// ---- router logic ----
async function handleMessage(psid, text, isEcho) {
  if (isEcho) {
    console.log("Ignoring echo for", psid);
    return;
  }

  console.log("Incoming:", { psid, text });

  if (isGreeting(text) && !isUsedCarIntent(text)) {
    await sendFBText(
      psid,
      "Hi po! 😊 Welcome to BentaCars. Interested po ba kayo sa used-car options o need ninyo ng tulong sa financing?"
    );
    return;
  }

  if (isUsedCarIntent(text)) {
    await sendFBText(psid, "Got it! Sige, iche-check ko ang best options for you. ⏳");
    try {
      const reply = await runWorkflowV2(text);
      await sendFBText(psid, reply);
    } catch (err) {
      console.error("Workflow v2 error:", err);
      await sendFBText(psid, "Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏");
    }
    return;
  }

  await sendFBText(
    psid,
    "Para matulungan kita agad, sabihin lang kung anong hanap mo (e.g. “sedan sa QC”, “used car options”, “financing with 80k DP”)."
  );
}

// ----- Meta verification -----
export async function GET(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// ----- Meta webhook -----
export async function POST(request) {
  try {
    const body = await request.json();

    const entry = body.entry?.[0];
    const event = entry?.messaging?.[0];
    if (!event?.sender?.id || !event?.message) {
      console.log("Non-message webhook event — ignoring");
      return json({ ok: true });
    }

    const psid = event.sender.id;
    const text = (event.message.text || "").trim();
    const isEcho = !!event.message.is_echo;

    await handleMessage(psid, text, isEcho);
    return json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return json({ error: String(err?.message || err) }, 200);
  }
}
