// Brevo mailing-list go-between.
// The page sends { email, source } here; this adds the contact to the
// Brevo list. The secrets live in Vercel environment variables
// (BREVO_API_KEY, BREVO_LIST_ID) — never in the public page.

function brevo(apiKey, payload) {
  return fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  var body = req.body || {};
  var email = typeof body.email === 'string' ? body.email.trim() : '';
  // Light sanity check — the form input already enforces type=email.
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid email' });
  }

  var apiKey = process.env.BREVO_API_KEY;
  var listId = Number(process.env.BREVO_LIST_ID);
  if (!apiKey || !listId) {
    console.error('Missing BREVO_API_KEY or BREVO_LIST_ID environment variable');
    return res.status(500).json({ ok: false, error: 'server not configured' });
  }

  // Tag which form the signup came from.
  var ALLOWED = ['guess-game', 'cta-footer', 'receipts'];
  var source = ALLOWED.indexOf(body.source) !== -1 ? body.source : 'unknown';

  var payload = {
    email: email,
    listIds: [listId],
    updateEnabled: true, // re-signups update the contact instead of failing
    attributes: { SOURCE: source }
  };

  try {
    var r = await brevo(apiKey, payload);
    if (!r.ok) {
      var detail = await r.text();
      // If the SOURCE attribute doesn't exist in this Brevo account yet,
      // retry without it rather than losing the signup.
      if (r.status === 400 && /attribute/i.test(detail)) {
        r = await brevo(apiKey, { email: email, listIds: [listId], updateEnabled: true });
      }
      if (!r.ok) {
        console.error('Brevo rejected signup:', r.status, detail);
        return res.status(502).json({ ok: false, error: 'provider rejected' });
      }
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Brevo request failed:', err);
    return res.status(502).json({ ok: false, error: 'provider unreachable' });
  }
};
