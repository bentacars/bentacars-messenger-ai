// api/webhook.js
// Runtime: Node 18+  (vercel.json -> { "functions": { "api/webhook.js": { "runtime": "nodejs18.x" }}})
// package.json -> { "type": "module", "dependencies": { "node-fetch": "^3.3.2" } }

import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    // --- Webhook Verification (GET) ---
    if (req.method === 'GET') {
      const VERIFY_TOKEN = (process.env.META_VERIFY_TOKEN || '').trim();
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('Webhook verified!');
        return res.status(200).send(challenge);
      }
      return res.sendStatus(403);
    }

    // --- Incoming Events (POST) ---
    if (req.method === 'POST') {
      // Body can be string or object depending on hosting; normalize it.
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      console.log('EVENT:', JSON.stringify(body, null, 2));

      // Basic guard for Page events
      if (body.object !== 'page' || !Array.isArray(body.entry)) {
        console.warn('Ignoring non-page or malformed event');
        return res.status(200).send('IGNORED');
      }

      // Iterate each entry
      for (const entry of body.entry) {
        const messaging = entry.messaging || entry.standby || [];
        for (const event of messaging) {
          const senderId = event?.sender?.id;
          if (!senderId) continue;

          // Handle postbacks
          if (event.postback) {
            const payload = event.postback.payload || '';
            console.log('POSTBACK EVENT:', payload);
            await sendText(senderId, `You tapped: ${payload}`);
            continue;
          }

          // Handle text messages
          const text = event.message?.text;
          if (typeof text === 'string' && text.length > 0) {
            console.log('MESSAGE EVENT:', { text });
            // Simple echo right now; later we’ll call your Agent workflow here.
            await sendText(senderId, `You said: “${text}”`);
            continue;
          }

          // Fallback for non-text
          if (event.message) {
            await sendText(senderId, `Got your message ✅`);
          }
        }
      }

      return res.status(200).send('EVENT_RECEIVED');
    }

    // All other methods
    return res.status(404).send('Not Found');
  } catch (err) {
    console.error('Webhook error:', err);
    // Always 200 for Meta to stop retry storms; log contains the error details.
    return res.status(200).send('EVENT_RECEIVED');
  }
}

/**
 * Send a plain-text reply via the FB Send API (with safe token checks + logs)
 */
async function sendText(psid, text) {
  const PAGE_TOKEN = (process.env.PAGE_ACCESS_TOKEN || '').trim();

  // Quick sanity checks to avoid confusing OAuth errors
  if (!PAGE_TOKEN || PAGE_TOKEN.length < 20 || !PAGE_TOKEN.startsWith('EA')) {
    console.error('FB SEND ERROR: Page token missing/invalid (length/prefix check failed).');
    return;
  }

  const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const payload = {
    recipient: { id: psid },
    message: { text }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let data = {};
  try { data = await resp.json(); } catch (_) {}

  if (!resp.ok) {
    console.error('FB SEND ERROR', resp.status, data);
  } else {
    console.log('FB SEND OK', data);
  }
}
