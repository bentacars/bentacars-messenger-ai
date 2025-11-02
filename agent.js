// /agents.js
import { Agent, Runner } from "@openai/agents";
import OpenAI from "openai";

/**
 * Single OpenAI client, reused by the Agents Runner.
 */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Qualifier Agent — asks ONLY the next missing field.
 */
const qualifierAgent = new Agent({
  name: "Qualifier Agent",
  model: "gpt-4.1",
  modelSettings: { temperature: 0.3, topP: 1, maxTokens: 1500, store: true },
  instructions: `
You are the BentaCars Consultant — friendly, expert, and helpful. Keep replies short, Taglish, and natural.

GOAL — collect:
- body_type
- location_city
- payment_type
- budget
- transmission
- (optional) client_name if user gives it

RULES:
1) Ask ONLY for the next missing field (no checklist).
2) If user gives multiple answers at once, parse and fill all you can.
3) If unclear, ask one polite follow-up.
4) When ALL required fields are filled, say you'll check the best 2 units.

ALWAYS return **pure JSON** in this exact shape (no extra keys, no surrounding text):
{
  "message": "<what to say to the user>",
  "client_name": "",
  "location_city": "",
  "body_type": "",
  "transmission": "",
  "budget": "",
  "payment_type": ""
}
(Leave "" for any not yet collected.)
`,
});

/**
 * Match Agent — reads a published CSV and returns the best 2 matches.
 */
const matchAgent = new Agent({
  name: "Match Agent",
  model: "gpt-4.1",
  modelSettings: { temperature: 0.2, topP: 1, maxTokens: 1800, store: true },
  instructions: (runCtx) => {
    const {
      stateInventoryUrl,
      stateBodyType,
      stateTransmission,
      statePaymentType,
      stateBudget,
    } = runCtx.context;

    return `
You are the BentaCars Match Agent.

Read the CSV at: ${stateInventoryUrl}

Use buyer prefs:
- body_type: ${stateBodyType}
- transmission: ${stateTransmission}
- payment_type: ${statePaymentType}
- budget: ${stateBudget}

CSV headers may include:
SKU, year, brand, model, variant, transmission, fuel_type, body_type, color, mileage,
image_1..image_10, drive_link, video_link, srp, all_in, city, province, price_status, updated_at

Matching rules:
1) Hard filters: body_type must match; transmission must match.
2) Budget:
   - If payment_type == "cash": compare vs SRP.
   - If payment_type == "financing": compare vs ALL_IN (all-in DP).
   - Allow a ₱50,000 tolerance above the user's budget (or above the upper bound of a range).
3) Rank top 2 by: closest to budget target → lower mileage → newer year.

Images:
- Return up to 5 images using image_1..image_5. If missing, use "".

Message:
- Short Taglish summary introducing the 2 picks. No raw JSON in the text.

ALWAYS return **pure JSON** in this exact shape:
{
  "message": "<summary to user>",
  "top_matches": [
    {
      "sku": "", "year": "", "brand": "", "model": "", "variant": "",
      "transmission": "", "fuel_type": "", "body_type": "", "color": "",
      "mileage": "", "city": "", "srp": "", "all_in": "",
      "image_1": "", "image_2": "", "image_3": "", "image_4": "", "image_5": "",
      "drive_link": "", "video_link": ""
    }
  ]
}
(Return **max 2** items in top_matches.)
`;
  },
});

/**
 * Display agent – simply echoes the chosen message to send to Messenger.
 */
const displayAgent = new Agent({
  name: "Display Message",
  model: "gpt-4.1",
  modelSettings: { temperature: 0.0, maxTokens: 200, store: false },
  instructions: (ctx) => `Output ONLY this, exactly:\n${ctx.context.stateLastMessage}`,
});

/**
 * Public function the webhook will call.
 * @param {string} inputText - user message text
 * @returns {Promise<{ text: string }>} - text to send back to Messenger
 */
export async function runAgents(inputText) {
  const state = {
    payment_type: "",
    client_name: "",
    location_city: "",
    body_type: "",
    transmission: "",
    budget: "",
    inventory_url:
      "https://docs.google.com/spreadsheets/d/e/2PACX-1vTJKqD-PChy-Vc_orJqBliwqY6mUsS0lqVO6-or4KnZfJV0Qgonocck4ShsvJg1GhHEx36DvPAjBWtS/pub?gid=632712572&single=true&output=csv",
    match_message: "",
    top_matches: [],
    last_message: "",
  };

  const runner = new Runner({
    client: openai,
    traceMetadata: {
      __trace_source__: "bentacars-messenger",
    },
  });

  const convo = [
    {
      role: "user",
      content: [{ type: "input_text", text: inputText }],
    },
  ];

  // 1) Qualifier
  const qa = await runner.run(qualifierAgent, convo);
  if (!qa.finalOutput) throw new Error("Qualifier agent returned no output.");
  let parsed;
  try {
    parsed =
      typeof qa.finalOutput === "string"
        ? JSON.parse(qa.finalOutput)
        : qa.finalOutput;
  } catch {
    parsed = { message: "Pasensya na po, pakiulit ng sagot?", ...state };
  }
  state.client_name = parsed.client_name ?? "";
  state.location_city = parsed.location_city ?? "";
  state.body_type = parsed.body_type ?? "";
  state.transmission = parsed.transmission ?? "";
  state.budget = parsed.budget ?? "";
  state.payment_type = parsed.payment_type ?? "";
  state.last_message = parsed.message ?? "Sige po, pakiulit po.";

  // If not complete yet, just display the next question
  const needsMore =
    !state.body_type || !state.location_city || !state.payment_type || !state.budget || !state.transmission;

  if (needsMore) {
    const show = await runner.run(
      displayAgent,
      convo,
      { context: { stateLastMessage: state.last_message } },
    );
    return { text: show.finalOutput ?? state.last_message };
  }

  // 2) Match
  const match = await runner.run(
    matchAgent,
    convo,
    {
      context: {
        stateInventoryUrl: state.inventory_url,
        stateBodyType: state.body_type,
        stateTransmission: state.transmission,
        statePaymentType: state.payment_type,
        stateBudget: state.budget,
      },
    }
  );
  if (!match.finalOutput) throw new Error("Match agent returned no output.");

  let matchParsed;
  try {
    matchParsed =
      typeof match.finalOutput === "string"
        ? JSON.parse(match.finalOutput)
        : match.finalOutput;
  } catch {
    matchParsed = { message: "Na-parse ko po ang sagot. May konting error—paki-try uli." };
  }

  state.match_message = matchParsed.message ?? "";
  state.top_matches = Array.isArray(matchParsed.top_matches)
    ? matchParsed.top_matches.slice(0, 2)
    : [];

  const show2 = await runner.run(
    displayAgent,
    convo,
    { context: { stateLastMessage: state.match_message || "May 2 akong nirekomenda. Tingnan natin!" } },
  );

  return { text: show2.finalOutput ?? state.match_message };
}
