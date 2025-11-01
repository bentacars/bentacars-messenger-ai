// api/webhook.js
// Vercel Edge/Node (standard serverless) – no extra deps

const META_GRAPH_URL = 'https://graph.facebook.com/v19.0';
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT = process.env.OPENAI_PROJECT;
// <-- IMPORTANT: keep your wf_... here, do NOT hardcode
const WORKFLOW_ID = process.env.WORKFLOW_ID;

// simple in-memory anti-loop debouncer (per PSID)
const lastReply = new Map();
const DEBOUNCE_MS = 4000;

function json(res, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function sendFBText(psid, text) {
  const now = Date.now();
  const last = lastReply.get(psid) || 0;
  if (now - last < DEBOUNCE_MS) {
    console.log('Debounced duplicate reply to', psid);
    return;
  }
  lastReply.set(psid, now);

  const body = {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: { text }
  };

  const r = await fetch(`${META_GRAPH_URL}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  const ok = r.ok;
  let respText = '';
  try { respText = await r.text(); } catch {}
  console.log('FB SEND:', ok ? 'OK' : 'FAIL', respText);
}

function looksLikeGreeting(t) {
  const s = t.toLowerCase();
  return /\b(hi|hello|helo|hey|kumusta|good\s*(am|pm|day)|hm|yo)\b/.test(s);
}

function looksLikeUsedCarIntent(t) {
  const s = t.toLowerCase();
  return [
    'used car',
    'used-car',
    'looking for',
    'hanap',
    'benta car',
    'buy car',
    'options',
    'vios', 'mirage', 'fortuner', 'innova', 'sedan', 'suv', 'mpv', 'hatchback',
    'financing',
    'installment',
    'dp',
    'all in',
    'downpayment',
    'loan'
  ].some(k => s.includes(k));
}

async function runWorkflowV2(userText) {
  // Workflows v2: SAME /v1 path, but MUST send header OpenAI-Beta: workflows=v2
  const url = `https://api.openai.com/v2/workflows/${WORKFLOW_ID}/runs`;

  const body = {
    // match your workflow’s input name
    inputs: { input_as_text: userText }
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${OPENAI_API_KEY}`,
      'content-type': 'application/json',
      'OpenAI-Project': OPENAI_PROJECT || '',
      'OpenAI-Beta': 'workflows=v2'
    },
    body: JSON.stringify(body)
  });

  // Some errors return HTML (nginx). Guard hard.
  const ct = r.headers.get('content-type') || '';
  const raw = await r.text();

  if (!r.ok) {
    console.error('OpenAI returned error:', raw);
    throw new Error(`OpenAI v2 error: ${raw}`);
  }

  let data;
  if (ct.includes('application/json')) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`OpenAI v2 JSON parse error: ${raw.slice(0, 200)}`);
    }
  } else {
    // Unexpected HTML or text
    throw new Error(`OpenAI v2 non-JSON response: ${raw.slice(0, 200)}`);
  }

  // The shape can vary; we’ll try common fields safely.
  // 1) If the workflow returns a single message string (our Display Message agent),
  //    you often get something like { output_text: "..."} or in outputs array.
  // Try a few fallbacks:

  const tryPaths = [
    // direct top-level text
    d => d.output_text,
    // typical “response” object with outputs
    d => d.response?.outputs?.[0]?.content?.[0]?.text,
    // generic “outputs”
    d => d.outputs?.[0]?.content?.[0]?.text,
    // sometimes the tool returns a “message”
    d => d.message,
    // whole response as string if tiny
    d => (typeof d === 'string' ? d : null)
  ];

  for (const pick of tryPaths) {
    const v = pick(data);
    if (typeof v === 'string' && v.trim()) return v.trim();
  }

  console.log('Workflow v2 raw JSON (unparsed):', JSON.stringify(data).slice(0, 400));
  // last resort
  return 'Salamat! Iche-check ko ang best options na bagay sa inyo. ⏳';
}

async function handleMessage(psid, text) {
  console.log('Incoming:', { senderId: psid, text });

  // 1) Greetings / small talk → short welcome, no workflow trigger yet.
  if (looksLikeGreeting(text) && !looksLikeUsedCarIntent(text)) {
    await sendFBText(
      psid,
      'Hi po! 😊 Welcome to BentaCars. Interested po ba kayo sa used-car options or need ninyo ng tulong sa financing?'
    );
    return;
  }

  // 2) If user shows intent for used-car/financing → call Workflow v2
  if (looksLikeUsedCarIntent(text)) {
    // Let the user know we’re working
    await sendFBText(psid, 'Got it! Sige, iche-check ko ang best options for you. ⏳');

    try {
      const reply = await runWorkflowV2(text);
      await sendFBText(psid, reply);
    } catch (err) {
      console.error('Workflow v2 failed:', err);
      await sendFBText(
        psid,
        'Medyo nagka-issue sa processing. Paki-type ulit or try another wording. 🙏'
      );
    }
    return;
  }

  // 3) Default nudge towards the main flow
  await sendFBText(
    psid,
    'Para matulungan ko kayo agad, sabihin lang kung anong hanap ninyo (hal. “sedan sa QC”, “used car options”, “financing with 80k DP”).'
  );
}

export async function GET(request) {
  // Meta Webhook verification
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const entry = body.entry?.[0];
    const change = entry?.messaging?.[0];

    if (!change?.sender?.id || !change?.message) {
      console.log('Non-message webhook event – ignoring');
      return json({ ok: true });
    }

    const senderId = change.sender.id;
    const text = change.message.text?.trim() || '';

    // Fire and await (we keep it simple; still under 20s SLA)
    await handleMessage(senderId, text);

    return json({ ok: true });
  } catch (err) {
    console.error('❌ Webhook error:', err);
    return json({ error: String(err?.message || err) }, 200);
  }
}
