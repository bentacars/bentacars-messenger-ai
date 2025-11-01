// api/webhook.js
// Messenger ↔ OpenAI v2 Workflows bridge with echo-guard + simple session

const META_GRAPH = 'https://graph.facebook.com/v18.0'; // v18 works fine
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT = process.env.OPENAI_PROJECT; // optional
const WORKFLOW_ID = process.env.WORKFLOW_ID;

// --- simple in-memory session (ok for now; moves to Redis later) ---
const SESSIONS = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getSession(userId) {
  const now = Date.now();
  const s = SESSIONS.get(userId);
  if (!s || (now - s.updatedAt) > SESSION_TTL_MS) {
    const fresh = { greeted: false, fallbackGiven: false, updatedAt: now };
    SESSIONS.set(userId, fresh);
    return fresh;
  }
  s.updatedAt = now;
  return s;
}

async function sendText(recipientId, text) {
  const url = `${META_GRAPH}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  const body = {
    recipient: { id: recipientId },
    message: { text }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  console.log('FB SEND ▶', { recipient_id: recipientId, message: text, status: res.status, resp: data });
  return data;
}

function looksLikeUsedCarIntent(t) {
  if (!t) return false;
  const text = t.toLowerCase();
  return [
    'used car','used-car','second hand','2nd hand','pre-owned','preowned',
    'finance','financing','installment','loan','dp','downpayment','down payment',
    'bili','buy','purchase','hanap','looking for','sedan','suv','mpv','van','pickup','hatchback',
    'vios','mirage','innova','fortuner','civic','accent','almera'
  ].some(k => text.includes(k));
}

async function runWorkflowV2(userText) {
  const url = `https://api.openai.com/v2/workflows/${WORKFLOW_ID}/runs`;
  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    ...(OPENAI_PROJECT ? {'OpenAI-Project': OPENAI_PROJECT} : {}),
    'Content-Type': 'application/json'
  };
  const payload = { input: { input_as_text: userText } };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();

  // v2 always returns JSON; if you ever see HTML, it’s a 404/HTML error page
  try {
    const json = JSON.parse(text);
    console.log('Workflow v2 ◀', json);
    // Try common result shapes
    const msg =
      json?.output?.message ??
      json?.result?.message ??
      json?.output_text ??
      json?.message ??
      null;

    if (typeof msg === 'string' && msg.trim()) return msg.trim();

    // As a fallback, stringify something meaningful
    return 'Thanks! Let me check that for you.';
  } catch (e) {
    console.error('Workflow v2 failed: raw:', text);
    throw new Error(`Workflow v2 failed: ${text.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  try {
    // --- Verify webhook (GET) ---
    if (req.method === 'GET') {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('Webhook verified');
        return res.status(200).send(challenge);
      }
      return res.status(403).send('Verification failed');
    }

    // --- Receive messages (POST) ---
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const body = req.body;
    // Messenger delivery format
    const entry = body?.entry?.[0];
    const messaging = entry?.messaging?.[0];
    console.log('Incoming ◀', JSON.stringify({ senderId: messaging?.sender?.id, text: messaging?.message?.text }, null, 2));

    // Guard: if nothing useful, ACK to avoid retries
    if (!messaging || !messaging.sender || !messaging.message) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const senderId = messaging.sender.id;

    // 🔒 IMPORTANT: Ignore page's own echoes to stop loops
    if (messaging.message.is_echo) {
      console.log('Skipping echo message');
      return res.status(200).send('OK');
    }

    const text = (messaging.message.text || '').trim();

    const session = getSession(senderId);

    // First-time greeting (once per session)
    if (!session.greeted) {
      session.greeted = true;
      await sendText(senderId, 'Hi po! 😊 Welcome to BentaCars. Interested po ba kayo sa used-car options or need ninyo ng tulong sa financing?');
      return res.status(200).send('OK');
    }

    // Route: Used-car / financing intent → run Workflow v2
    if (looksLikeUsedCarIntent(text)) {
      await sendText(senderId, 'Got it! Sige, iche-check ko ang best options for you. ⏳');
      try {
        const reply = await runWorkflowV2(text);
        await sendText(senderId, reply);
      } catch (err) {
        console.error('Workflow error ▶', err);
        await sendText(senderId, 'Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏');
      }
      return res.status(200).send('OK');
    }

    // Soft fallback (only once per session to avoid spam)
    if (!session.fallbackGiven) {
      session.fallbackGiven = true;
      await sendText(senderId, 'Sige! Paki-sabihin kung naghahanap kayo ng used-car (hal. “sedan sa QC”) o kung financing assistance ang kailangan.');
      return res.status(200).send('OK');
    }

    // Final neutral ACK
    await sendText(senderId, 'Noted po. Sabihin lang ang body type (sedan/SUV/van…), city, at cash or financing para makapag-match ako.');
    return res.status(200).send('OK');

  } catch (err) {
    console.error('❌ Webhook error:', err);
    // Always 200 to stop FB retries; send a generic message if we still can’t process
    try {
      const senderId = req?.body?.entry?.[0]?.messaging?.[0]?.sender?.id;
      if (senderId) await sendText(senderId, 'Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏');
    } catch {}
    return res.status(200).send('OK');
  }
}
