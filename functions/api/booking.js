// Cloudflare Pages Function: POST /api/booking
// Receives the "Request for Booking" form on scheduling.html and emails it via Resend.
//
// Required env (Cloudflare Pages > Settings > Variables and Secrets, Production + Preview):
//   RESEND_API_KEY   (secret)  Resend key, "Sending access" only, restricted to fairbairninspections.com
//   BOOKING_TO       (text)    Where requests go. Comma-separate for multiple. e.g. info@fairbairninspections.com
//   BOOKING_FROM     (text)    Verified sender. e.g. Fairbairn Website <bookings@fairbairninspections.com>

const MAX = { short: 160, address: 250, comments: 3000 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestPost({ request, env }) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');

  let data;
  try {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await request.json();
    } else {
      data = Object.fromEntries((await request.formData()).entries());
    }
  } catch {
    return reply(wantsJson, 400, 'Invalid request.');
  }

  // Spam traps: honeypot filled, or submitted faster than a human could (under 3s).
  // Pretend success so bots don't learn anything.
  const t = Number(data.t);
  if (data.website || (t && Date.now() - t < 3000)) return reply(wantsJson, 200);

  const s = (k, n = MAX.short) => String(data[k] ?? '').trim().slice(0, n);
  const f = {
    role: s('role'),
    clientName: s('clientName'),
    clientEmail: s('clientEmail'),
    clientPhone: s('clientPhone'),
    agentName: s('agentName'),
    agentEmail: s('agentEmail'),
    address: s('address', MAX.address),
    time: s('time'),
    comments: s('comments', MAX.comments),
  };

  // Dates: JS sends "2026-10-03,2026-10-05"; no-JS fallback sends free text in datesText.
  const dates = String(data.dates || '').split(',').map(d => d.trim()).filter(d => ISO_DATE.test(d)).slice(0, 60).sort();
  const datesText = s('datesText', 300);

  // Server-side validation (never trust the browser)
  const errs = [];
  const isAgent = f.role === 'Agent';
  if (!['Client', 'Agent'].includes(f.role)) errs.push('role');
  if (!f.clientName) errs.push('clientName');
  if (!isAgent && !EMAIL.test(f.clientEmail)) errs.push('clientEmail');
  if (!isAgent && f.clientPhone.replace(/\D/g, '').length < 10) errs.push('clientPhone');
  if (isAgent && (!f.agentName || !EMAIL.test(f.agentEmail))) errs.push('agent');
  if (!f.address) errs.push('address');
  if (!dates.length && !datesText) errs.push('dates');
  if (!['Morning', 'Afternoon', 'Either'].includes(f.time)) errs.push('time');
  if (errs.length) return reply(wantsJson, 422, 'Missing or invalid: ' + errs.join(', '));

  if (!env.RESEND_API_KEY || !env.BOOKING_TO || !env.BOOKING_FROM) {
    console.error('booking: missing env vars');
    return reply(wantsJson, 500, 'Form not configured.');
  }

  const prettyDates = dates.length
    ? dates.map(d => {
        const [y, m, day] = d.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      })
    : [datesText];

  // Reply-To goes to whoever submitted, so the office can just hit Reply.
  const replyTo = [];
  if (isAgent && EMAIL.test(f.agentEmail)) replyTo.push(f.agentEmail);
  if (EMAIL.test(f.clientEmail)) replyTo.push(f.clientEmail);
  if (!isAgent && EMAIL.test(f.agentEmail)) replyTo.push(f.agentEmail);

  const rows = [
    ['Submitted by', f.role],
    ["Client's name", f.clientName],
    ["Client's email", f.clientEmail, f.clientEmail && `mailto:${f.clientEmail}`],
    ["Client's phone", f.clientPhone, f.clientPhone && `tel:${f.clientPhone.replace(/[^\d+]/g, '')}`],
    ["Agent's name", f.agentName],
    ["Agent's email", f.agentEmail, f.agentEmail && `mailto:${f.agentEmail}`],
    ['Property address', f.address, `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(f.address)}`],
    ['Dates available', prettyDates.map(esc).join('<br>'), null, true],
    ['Preferred time', f.time],
    ['Comments', esc(f.comments).replace(/\n/g, '<br>'), null, true],
  ];

  const html = `<!doctype html><html><body style="margin:0;background:#f5f2ec;font-family:Arial,Helvetica,sans-serif;color:#1a1a18">
<div style="max-width:620px;margin:0 auto;padding:24px">
  <div style="background:#1a1a18;color:#fff;padding:20px 24px;border-bottom:3px solid #1d5f78">
    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8fb8c8">Website Booking Request</div>
    <div style="font-size:22px;margin-top:6px">${esc(f.address)}</div>
  </div>
  <table cellpadding="0" cellspacing="0" style="width:100%;background:#fff;border-collapse:collapse">
    ${rows.map(([k, v, href, raw]) => `<tr>
      <td style="padding:12px 24px;border-bottom:1px solid #ede9e0;font-size:12px;color:#7a7268;width:150px;vertical-align:top">${k}</td>
      <td style="padding:12px 24px 12px 0;border-bottom:1px solid #ede9e0;font-size:15px;vertical-align:top">${
        !v ? '<span style="color:#c2bcb1">(not provided)</span>'
        : href ? `<a href="${esc(href)}" style="color:#1d5f78">${esc(v)}</a>`
        : raw ? v : esc(v)}</td></tr>`).join('')}
  </table>
  <p style="font-size:12px;color:#7a7268;margin-top:16px">Hit Reply to respond directly to ${replyTo.length ? esc(replyTo.join(' and ')) : 'the requester'}. Sent from the booking form at fairbairninspections.com/scheduling.html</p>
</div></body></html>`;

  const text = [
    'WEBSITE BOOKING REQUEST', '',
    `Submitted by: ${f.role}`,
    `Client's name: ${f.clientName}`,
    `Client's email: ${f.clientEmail || '-'}`,
    `Client's phone: ${f.clientPhone || '-'}`,
    `Agent's name: ${f.agentName || '-'}`,
    `Agent's email: ${f.agentEmail || '-'}`,
    `Property address: ${f.address}`,
    `Dates available: ${prettyDates.join(', ')}`,
    `Preferred time: ${f.time}`,
    '', 'Comments:', f.comments || '-',
  ].join('\n');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.BOOKING_FROM,
      to: env.BOOKING_TO.split(',').map(x => x.trim()).filter(Boolean),
      reply_to: replyTo.length ? replyTo : undefined,
      subject: `Booking request: ${f.address} (${f.role}: ${isAgent ? f.agentName : f.clientName})`.replace(/[\r\n]+/g, ' ').slice(0, 200),
      html,
      text,
    }),
  });

  if (!res.ok) {
    console.error('booking: resend error', res.status, await res.text());
    return reply(wantsJson, 502, 'Email service error.');
  }
  return reply(wantsJson, 200);
}

function reply(json, status, error) {
  if (json) {
    return new Response(JSON.stringify(status < 300 ? { ok: true } : { ok: false, error }), {
      status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  // No-JS fallback: bounce back to the page
  const loc = status < 300 ? '/scheduling.html?sent=1#request' : '/scheduling.html#request';
  return new Response(null, { status: 303, headers: { Location: loc } });
}

function esc(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
