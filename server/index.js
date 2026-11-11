import { createServer } from 'node:http';
import { readFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = join(root, 'dist');
const dataDir = join(root, 'data');
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'reach.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL, consent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, credits INTEGER NOT NULL, price_ghs REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, credits INTEGER NOT NULL, amount_ghs REAL NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, audience TEXT NOT NULL, message TEXT NOT NULL, recipients INTEGER NOT NULL, credits_used INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'Manual recipients', message TEXT NOT NULL DEFAULT '', recipient_numbers TEXT NOT NULL DEFAULT '[]', sender_id INTEGER, scheduled_for TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sender_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, provider_id TEXT, name TEXT NOT NULL, use_case TEXT NOT NULL, sample_message TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TEXT NOT NULL);
`);
try { db.exec('ALTER TABLE wallets ADD COLUMN user_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE campaigns ADD COLUMN user_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE campaigns ADD COLUMN recipient_numbers TEXT'); } catch {}
try { db.exec('ALTER TABLE campaigns ADD COLUMN provider_message_ids TEXT'); } catch {}
try { db.exec('ALTER TABLE campaigns ADD COLUMN provider TEXT'); } catch {}
try { db.exec('ALTER TABLE campaigns ADD COLUMN scheduled_for TEXT'); } catch {}
try { db.exec('ALTER TABLE campaigns ADD COLUMN sender_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE purchases ADD COLUMN user_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE purchases ADD COLUMN reference TEXT'); } catch {}
try { db.exec('ALTER TABLE purchases ADD COLUMN gateway TEXT'); } catch {}
// Older versions could create several wallet rows for one user. Keep the
// highest balance (the value previously shown in the workspace) and collapse
// the duplicates before enforcing the one-wallet-per-user rule.
db.exec("UPDATE wallets SET user_id = 1 WHERE id = 1 AND user_id IS NULL");
const duplicateWallets = db.prepare('SELECT user_id as userId, MAX(credits) as credits, MAX(updated_at) as updatedAt, MIN(id) as keepId FROM wallets WHERE user_id IS NOT NULL GROUP BY user_id HAVING COUNT(*) > 1').all();
for (const duplicate of duplicateWallets) {
  db.prepare('UPDATE wallets SET credits = ?, updated_at = ? WHERE id = ?').run(duplicate.credits, duplicate.updatedAt || new Date().toISOString(), duplicate.keepId);
  db.prepare('DELETE FROM wallets WHERE user_id = ? AND id <> ?').run(duplicate.userId, duplicate.keepId);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_id_unique ON wallets(user_id) WHERE user_id IS NOT NULL');
db.exec("INSERT OR IGNORE INTO users (id, name, email, password_hash, created_at) VALUES (1, 'Demo workspace', 'demo@reach.test', 'demo', datetime('now'))");
db.exec("INSERT OR IGNORE INTO wallets (id, user_id, credits, updated_at) VALUES (1, 1, 0, datetime('now'))");
const addPlan = db.prepare('INSERT OR IGNORE INTO plans (id, name, credits, price_ghs) VALUES (?, ?, ?, ?)');
[
  ['starter', 'Starter', 100, 3],
  ['growth', 'Growth', 500, 15],
  ['scale', 'Scale', 1000, 30],
  ['launch', 'Launch', 2500, 75],
  ['momentum', 'Momentum', 5000, 150],
  ['pro', 'Pro', 10000, 300],
  ['business', 'Business', 25000, 750],
  ['plus', 'Plus', 50000, 1500],
  ['enterprise', 'Enterprise', 100000, 3000],
  ['volume', 'Volume', 250000, 7500],
  ['scale-up', 'Scale up', 500000, 15000],
  ['maximum', 'Maximum', 1000000, 30000]
].forEach((plan) => addPlan.run(...plan));

const json = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }); res.end(JSON.stringify(payload)); };
const now = () => new Date().toISOString();
const normalizeSenderStatus = (status) => {
  const value = String(status || 'pending').toLowerCase();
  return value === 'approved' || value === 'active' ? 'active' : value === 'rejected' ? 'rejected' : 'pending';
};
const body = async (req) => { let value = ''; for await (const chunk of req) value += chunk; return value ? JSON.parse(value) : {}; };
const rawBody = async (req) => { let value = ''; for await (const chunk of req) value += chunk; return value; };
const sendViaSailup = async ({ recipients, message, senderId }) => {
  const apiKey = process.env.SAILUP_API_KEY;
  if (!apiKey) throw new Error('Sailup is not configured. Set SAILUP_API_KEY on the server before sending.');
  const baseUrl = (process.env.SAILUP_API_URL || 'https://api.sailup.io/v1').replace(/\/+$/, '');
  const request = () => fetch(`${baseUrl}/sms/`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ from: senderId || process.env.SAILUP_SENDER_ID || 'Reach', to: recipients, body: message })
  });
  let response;
  try { response = await request(); } catch (error) {
    const reason = error?.cause?.code || error?.code || error?.name || 'network error';
    throw new Error(`Could not connect to Sailup (${reason}). Check the server internet connection and SAILUP_API_URL.`);
  }
  const responseText = await response.text();
  let payload = {};
  try { payload = responseText ? JSON.parse(responseText) : {}; } catch { payload = {}; }
  if (!response.ok) {
    const detail = payload.detail || payload.error || payload.message || `Sailup returned HTTP ${response.status}.`;
    if (detail === 'sender_not_approved' || /sender.?not.?approved/i.test(detail)) {
      throw new Error(`Sender ID "${process.env.SAILUP_SENDER_ID || 'Reach'}" is not approved by Sailup. Register and approve this sender ID in Sailup, then restart the backend.`);
    }
    throw new Error(detail);
  }
  return payload;
};
const processScheduledCampaigns = async () => {
  const due = db.prepare("SELECT id, user_id as userId, message, recipients, recipient_numbers as recipientNumbers, sender_id as senderId FROM campaigns WHERE status = 'Scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= ? ORDER BY id LIMIT 10").all(now());
  for (const campaign of due) {
    const numbers = JSON.parse(campaign.recipientNumbers || '[]');
    const sender = db.prepare("SELECT name FROM sender_submissions WHERE id = ? AND user_id = ? AND status IN ('active', 'approved')").get(campaign.senderId, campaign.userId);
    if (!sender) { db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run('Failed', campaign.id); db.prepare('UPDATE wallets SET credits = credits + ?, updated_at = ? WHERE user_id = ?').run(campaign.recipients, now(), campaign.userId); continue; }
    db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run('Sending', campaign.id);
    try {
      const response = await sendViaSailup({ recipients: numbers, message: campaign.message, senderId: sender.name });
      const ids = Array.isArray(response.messages) ? response.messages.map((item) => item.id).filter(Boolean) : [];
      db.prepare('UPDATE campaigns SET status = ?, provider_message_ids = ? WHERE id = ?').run('Queued', JSON.stringify(ids), campaign.id);
    } catch {
      db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run('Failed', campaign.id);
      db.prepare('UPDATE wallets SET credits = credits + ?, updated_at = ? WHERE user_id = ?').run(campaign.recipients, now(), campaign.userId);
    }
  }
};
setInterval(() => { processScheduledCampaigns().catch(() => {}); }, 15000);
const paystackRequest = async (path, options = {}) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error('Paystack is not configured. Set PAYSTACK_SECRET_KEY on the server before accepting payments.');
  const response = await fetch(`https://api.paystack.co${path}`, { ...options, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === false) throw new Error(payload.message || `Paystack returned HTTP ${response.status}.`);
  return payload;
};
const sailupRequest = async (path, options = {}) => {
  const apiKey = process.env.SAILUP_API_KEY;
  if (!apiKey) throw new Error('Sailup is not configured. Set SAILUP_API_KEY on the server before registering a sender ID.');
  const baseUrl = (process.env.SAILUP_API_URL || 'https://api.sailup.io/v1').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}${path}`, { ...options, signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) } });
  const raw = await response.text();
  let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok || payload.error) throw new Error(payload.message || payload.detail || payload.error || `Sailup returned HTTP ${response.status}.`);
  return payload;
};
const fulfillPaystackPayment = (reference, verifiedData) => {
  const purchase = db.prepare('SELECT id, user_id as userId, plan_id as planId, credits, amount_ghs as amountGhs, status FROM purchases WHERE reference = ?').get(reference);
  if (!purchase) throw new Error('Payment reference was not found.');
  if (purchase.status === 'paid') return { purchase, wallet: wallet(purchase.userId) };
  const expectedAmount = Math.round(Number(purchase.amountGhs) * 100);
  if (verifiedData.status !== 'success' || Number(verifiedData.amount) !== expectedAmount || verifiedData.currency !== 'GHS') throw new Error('Paystack payment verification failed.');
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT status FROM purchases WHERE id = ?').get(purchase.id);
    if (current.status !== 'paid') {
      db.prepare('UPDATE wallets SET credits = credits + ?, updated_at = ? WHERE user_id = ?').run(purchase.credits, timestamp, purchase.userId);
      db.prepare('UPDATE purchases SET status = ?, gateway = ? WHERE id = ?').run('paid', 'paystack', purchase.id);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { purchase: { ...purchase, status: 'paid' }, wallet: wallet(purchase.userId) };
};
const authUser = (req) => { const token = req.headers.authorization?.replace('Bearer ', ''); const id = Number(token); return Number.isInteger(id) && id > 0 ? db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(id) : null; };
const wallet = (userId) => db.prepare('SELECT credits, updated_at as updatedAt FROM wallets WHERE user_id = ?').get(userId) || { credits: 0 };
const ensureWallet = (userId) => { db.prepare("INSERT OR IGNORE INTO wallets (user_id, credits, updated_at) VALUES (?, 0, datetime('now'))").run(userId); return wallet(userId); };
const passwordHash = (password) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const passwordMatches = (password, stored) => { if (stored === 'demo') return false; const [salt, hash] = stored.split(':'); return hash && timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64)); };

async function route(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'reach-api' });
    if (req.method === 'POST' && url.pathname === '/api/auth/signup') { const { name, email, password } = await body(req); if (!name || !email || !password || password.length < 6) return json(res, 400, { error: 'Name, email, and a password of at least 6 characters are required.' }); try { const result = db.prepare('INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(name.trim(), email.trim().toLowerCase(), passwordHash(password), now()); const userId = Number(result.lastInsertRowid); ensureWallet(userId); return json(res, 201, { token: String(userId), user: db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId) }); } catch { return json(res, 409, { error: 'An account with that email already exists.' }); } }
    if (req.method === 'POST' && url.pathname === '/api/auth/signin') { const { email, password } = await body(req); const user = db.prepare('SELECT id, name, email, password_hash as passwordHash FROM users WHERE email = ?').get(email?.trim().toLowerCase()); if (!user || !passwordMatches(password || '', user.passwordHash)) return json(res, 401, { error: 'Email or password is incorrect.' }); ensureWallet(user.id); return json(res, 200, { token: String(user.id), user: { id: user.id, name: user.name, email: user.email } }); }
    if (req.method === 'POST' && url.pathname === '/api/webhooks/sailup') {
      const raw = await rawBody(req);
      const secret = process.env.SAILUP_WEBHOOK_SECRET;
      const timestamp = req.headers['x-sailup-timestamp'];
      const signature = String(req.headers['x-sailup-signature'] || '').replace(/^sha256=/, '');
      if (!secret || !timestamp || !signature) return json(res, 401, { error: 'Invalid Sailup webhook signature.' });
      const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
      const receivedBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expected, 'hex');
      if (receivedBuffer.length !== expectedBuffer.length || !timingSafeEqual(receivedBuffer, expectedBuffer)) return json(res, 401, { error: 'Invalid Sailup webhook signature.' });
      const event = JSON.parse(raw);
      const senderData = event.data?.sender || event.data || {};
      const senderProviderId = senderData.id || senderData.sender_id || senderData.senderId;
      const eventName = String(event.event || event.type || '').toLowerCase();
      const senderStatus = eventName.includes('approved') ? 'active' : eventName.includes('rejected') ? 'rejected' : ['approved', 'active', 'rejected', 'pending', 'review'].includes(String(senderData.status || '').toLowerCase()) ? normalizeSenderStatus(senderData.status) : null;
      if (senderProviderId && senderStatus) db.prepare('UPDATE sender_submissions SET status = ? WHERE provider_id = ?').run(senderStatus, senderProviderId);
      const providerId = event.data?.id || event.data?.message_id;
      const statusByEvent = { 'message.delivered': 'Delivered', 'message.failed': 'Failed', 'message.expired': 'Expired', 'message.rejected': 'Rejected' };
      const campaignStatus = statusByEvent[event.event];
      if (providerId && campaignStatus) db.prepare('UPDATE campaigns SET status = ? WHERE provider_message_ids LIKE ?').run(campaignStatus, `%${providerId}%`);
      return json(res, 200, { received: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/webhooks/paystack') {
      const raw = await rawBody(req);
      const secret = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;
      const modernSignature = String(req.headers['paystack-signature'] || '');
      const legacySignature = String(req.headers['x-paystack-signature'] || '');
      if (!secret || (!modernSignature && !legacySignature)) return json(res, 401, { error: 'Invalid Paystack webhook signature.' });
      const validModern = modernSignature.split(',').some((part) => {
        if (!part.startsWith('v1=')) return false;
        const received = part.slice(3).split(':').pop();
        const timestamp = modernSignature.split(',').find((item) => item.startsWith('t='))?.slice(2);
        if (!timestamp || !received) return false;
        const expected = createHmac('sha512', secret).update(`${timestamp}.${raw}`).digest('hex');
        const receivedBuffer = Buffer.from(received, 'hex');
        const expectedBuffer = Buffer.from(expected, 'hex');
        return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
      });
      const expectedLegacy = createHmac('sha512', secret).update(raw).digest('hex');
      const legacyBuffer = Buffer.from(legacySignature, 'hex');
      const expectedLegacyBuffer = Buffer.from(expectedLegacy, 'hex');
      const validLegacy = legacySignature && legacyBuffer.length === expectedLegacyBuffer.length && timingSafeEqual(legacyBuffer, expectedLegacyBuffer);
      if (!validModern && !validLegacy) return json(res, 401, { error: 'Invalid Paystack webhook signature.' });
      const event = JSON.parse(raw);
      if (event.event === 'charge.success' && event.data?.reference) {
        try { fulfillPaystackPayment(event.data.reference, event.data); } catch (error) { return json(res, 400, { error: error.message }); }
      }
      return json(res, 200, { received: true });
    }
    const user = authUser(req);
    if (req.method === 'GET' && url.pathname === '/api/me') { if (!user) return json(res, 401, { error: 'Sign in required.' }); return json(res, 200, { user, wallet: ensureWallet(user.id) }); }
    if (req.method === 'GET' && url.pathname === '/api/plans') return json(res, 200, { plans: db.prepare('SELECT id, name, credits, price_ghs as priceGhs FROM plans ORDER BY credits').all() });
    if (!user) return json(res, 401, { error: 'Sign in required.' });
    if (req.method === 'GET' && url.pathname === '/api/senders') return json(res, 200, { senders: db.prepare('SELECT id, provider_id as providerId, name, use_case as useCase, sample_message as sampleMessage, notes, status, created_at as createdAt FROM sender_submissions WHERE user_id = ? ORDER BY id DESC').all(user.id) });
    if (req.method === 'POST' && url.pathname === '/api/senders') {
      const { name, useCase, sampleMessage, notes = '' } = await body(req);
      const cleanName = String(name || '').trim();
      const cleanSample = String(sampleMessage || '').trim();
      if (!/^(?=.{3,11}$)[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(cleanName)) return json(res, 400, { error: 'Sender ID must be 3–11 characters using letters, numbers, and single spaces.' });
      if (!['transactional', 'promotional'].includes(useCase)) return json(res, 400, { error: 'Choose a transactional or promotional use case.' });
      if (!cleanSample || cleanSample.length > 500) return json(res, 400, { error: 'Add a sample message up to 500 characters.' });
      try {
        const provider = await sailupRequest('/senders/', { method: 'POST', body: JSON.stringify({ name: cleanName, use_case: useCase, sample_message: cleanSample, notes: String(notes).trim().slice(0, 500) }) });
        const sender = provider.data || provider;
        const status = normalizeSenderStatus(sender.status);
        const result = db.prepare('INSERT INTO sender_submissions (user_id, provider_id, name, use_case, sample_message, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(user.id, sender.id || null, cleanName, useCase, cleanSample, String(notes).trim().slice(0, 500), status, now());
        return json(res, 201, { sender: { id: Number(result.lastInsertRowid), providerId: sender.id || null, name: cleanName, useCase, sampleMessage: cleanSample, notes, status } });
      } catch (error) { return json(res, 502, { error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/wallet') return json(res, 200, ensureWallet(user.id));
    if (req.method === 'GET' && url.pathname === '/api/purchases') return json(res, 200, { purchases: db.prepare('SELECT id, plan_id as planId, reference, credits, amount_ghs as amountGhs, status, gateway, created_at as createdAt FROM purchases WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(user.id) });
    if (req.method === 'POST' && url.pathname === '/api/payments/initialize') {
      const { planId } = await body(req);
      const plan = db.prepare('SELECT id, credits, price_ghs as priceGhs FROM plans WHERE id = ?').get(planId);
      if (!plan) return json(res, 400, { error: 'Unknown credit plan.' });
      const reference = `reach_${user.id}_${Date.now()}_${randomBytes(5).toString('hex')}`;
      const callbackUrl = process.env.PAYSTACK_CALLBACK_URL || `${process.env.APP_URL || 'http://localhost:5173'}/payment/callback`;
      const payment = await paystackRequest('/transaction/initialize', { method: 'POST', body: JSON.stringify({ email: user.email, amount: Math.round(plan.priceGhs * 100), currency: 'GHS', reference, callback_url: callbackUrl, metadata: { userId: user.id, planId: plan.id, credits: plan.credits } }) });
      db.prepare('INSERT INTO purchases (user_id, plan_id, reference, credits, amount_ghs, status, gateway, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(user.id, plan.id, reference, plan.credits, plan.priceGhs, 'pending', 'paystack', now());
      return json(res, 201, { authorizationUrl: payment.data.authorization_url, accessCode: payment.data.access_code, reference });
    }
    if (req.method === 'POST' && url.pathname === '/api/payments/verify') {
      const { reference } = await body(req);
      if (!reference) return json(res, 400, { error: 'Payment reference is required.' });
      const purchase = db.prepare('SELECT id FROM purchases WHERE reference = ? AND user_id = ?').get(reference, user.id);
      if (!purchase) return json(res, 404, { error: 'Payment reference was not found.' });
      const verification = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
      const result = fulfillPaystackPayment(reference, verification.data);
      return json(res, 200, { wallet: result.wallet, purchase: result.purchase });
    }
    if (req.method === 'GET' && url.pathname === '/api/drafts') {
      const drafts = db.prepare('SELECT id, name, audience, message, recipient_numbers as recipientNumbers, sender_id as senderId, scheduled_for as scheduledFor, created_at as createdAt, updated_at as updatedAt FROM drafts WHERE user_id = ? ORDER BY id DESC').all(user.id).map((draft) => ({ ...draft, recipientNumbers: JSON.parse(draft.recipientNumbers || '[]') }));
      return json(res, 200, { drafts });
    }
    if (req.method === 'POST' && url.pathname === '/api/drafts') {
      const { id, name = 'Untitled campaign', audience = 'Manual recipients', message = '', recipientNumbers = [], senderId = null, scheduledFor = null } = await body(req);
      if (!Array.isArray(recipientNumbers)) return json(res, 400, { error: 'Recipient numbers must be a list.' });
      const timestamp = now();
      if (id) {
        const result = db.prepare('UPDATE drafts SET name = ?, audience = ?, message = ?, recipient_numbers = ?, sender_id = ?, scheduled_for = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(String(name).trim() || 'Untitled campaign', audience, message, JSON.stringify(recipientNumbers), senderId ? Number(senderId) : null, scheduledFor || null, timestamp, Number(id), user.id);
        if (!result.changes) return json(res, 404, { error: 'Draft not found.' });
        return json(res, 200, { draft: { id: Number(id), name, audience, message, recipientNumbers, senderId, scheduledFor, updatedAt: timestamp } });
      }
      const result = db.prepare('INSERT INTO drafts (user_id, name, audience, message, recipient_numbers, sender_id, scheduled_for, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(user.id, String(name).trim() || 'Untitled campaign', audience, message, JSON.stringify(recipientNumbers), senderId ? Number(senderId) : null, scheduledFor || null, timestamp, timestamp);
      return json(res, 201, { draft: { id: Number(result.lastInsertRowid), name, audience, message, recipientNumbers, senderId, scheduledFor, createdAt: timestamp, updatedAt: timestamp } });
    }
    const draftMatch = url.pathname.match(/^\/api\/drafts\/(\d+)$/);
    if (draftMatch && req.method === 'DELETE') { const result = db.prepare('DELETE FROM drafts WHERE id = ? AND user_id = ?').run(Number(draftMatch[1]), user.id); if (!result.changes) return json(res, 404, { error: 'Draft not found.' }); return json(res, 200, { deleted: true }); }
    if (req.method === 'GET' && url.pathname === '/api/campaigns') return json(res, 200, { campaigns: db.prepare('SELECT id, name, audience, message, recipients, credits_used as creditsUsed, status, scheduled_for as scheduledFor, created_at as createdAt FROM campaigns WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(user.id) });
    if (req.method === 'GET' && url.pathname === '/api/contacts') return json(res, 200, { contacts: db.prepare('SELECT id, first_name as firstName, last_name as lastName, phone, consent, created_at as createdAt FROM contacts WHERE user_id = ? ORDER BY id DESC').all(user.id) });
    if (req.method === 'POST' && url.pathname === '/api/contacts') { const { firstName, lastName, phone, consent } = await body(req); if (!firstName || !phone) return json(res, 400, { error: 'First name and phone are required.' }); const result = db.prepare('INSERT INTO contacts (user_id, first_name, last_name, phone, consent, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, firstName.trim(), (lastName || '').trim(), phone.trim(), consent ? 1 : 0, now()); return json(res, 201, { contact: { id: Number(result.lastInsertRowid), firstName: firstName.trim(), lastName: (lastName || '').trim(), phone: phone.trim(), consent: Boolean(consent) } }); }
    const contactMatch = url.pathname.match(/^\/api\/contacts\/(\d+)$/);
    if (contactMatch && req.method === 'PUT') { const contactId = Number(contactMatch[1]); const { firstName, lastName, phone, consent } = await body(req); if (!firstName || !phone) return json(res, 400, { error: 'First name and phone are required.' }); const result = db.prepare('UPDATE contacts SET first_name = ?, last_name = ?, phone = ?, consent = ? WHERE id = ? AND user_id = ?').run(firstName.trim(), (lastName || '').trim(), phone.trim(), consent ? 1 : 0, contactId, user.id); if (!result.changes) return json(res, 404, { error: 'Contact not found.' }); return json(res, 200, { contact: { id: contactId, firstName: firstName.trim(), lastName: (lastName || '').trim(), phone: phone.trim(), consent: Boolean(consent) } }); }
    if (contactMatch && req.method === 'DELETE') { const result = db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(Number(contactMatch[1]), user.id); if (!result.changes) return json(res, 404, { error: 'Contact not found.' }); return json(res, 200, { deleted: true }); }
    if (req.method === 'POST' && url.pathname === '/api/campaigns') {
      const { name, audience, message, recipients, recipientNumbers = [], senderId, scheduledFor = null } = await body(req);
      const count = Number(recipients);
      if (!name || !message || !Number.isInteger(count) || count < 1) return json(res, 400, { error: 'Campaign name, message, and a valid recipient count are required.' });
      if (!Array.isArray(recipientNumbers) || recipientNumbers.length !== count) return json(res, 400, { error: 'Recipient numbers must match the recipient count.' });
      const activeSender = senderId ? db.prepare("SELECT name FROM sender_submissions WHERE user_id = ? AND id = ? AND status IN ('active', 'approved')").get(user.id, Number(senderId)) : db.prepare("SELECT name FROM sender_submissions WHERE user_id = ? AND status IN ('active', 'approved') ORDER BY id DESC LIMIT 1").get(user.id);
      if (!activeSender) return json(res, 409, { error: 'Register a sender ID and wait for Sailup approval before sending campaigns.' });
      const current = wallet(user.id);
      if (current.credits < count) return json(res, 402, { error: `You need ${count} credits but only have ${current.credits}.` });
      const timestamp = now();
      let campaignId;
      db.exec('BEGIN IMMEDIATE');
      try {
        const debit = db.prepare('UPDATE wallets SET credits = credits - ?, updated_at = ? WHERE user_id = ? AND credits >= ?').run(count, timestamp, user.id, count);
        if (debit.changes !== 1) { db.exec('ROLLBACK'); return json(res, 402, { error: `You need ${count} credits but only have ${wallet(user.id).credits}.` }); }
        const isScheduled = scheduledFor && new Date(scheduledFor).getTime() > Date.now();
        const created = db.prepare('INSERT INTO campaigns (user_id, name, audience, message, recipients, recipient_numbers, credits_used, status, provider, scheduled_for, sender_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(user.id, name, audience || 'Contacts', message, count, JSON.stringify(recipientNumbers), count, isScheduled ? 'Scheduled' : 'Sending', 'sailup', isScheduled ? new Date(scheduledFor).toISOString() : null, Number(senderId), timestamp);
        campaignId = Number(created.lastInsertRowid);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (scheduledFor && new Date(scheduledFor).getTime() > Date.now()) return json(res, 201, { wallet: wallet(user.id), campaign: { id: campaignId, name, audience, recipients: count, creditsUsed: count, status: 'Scheduled', scheduledFor: new Date(scheduledFor).toISOString(), provider: 'sailup' } });
      let providerResponse;
      try {
        providerResponse = await sendViaSailup({ recipients: recipientNumbers, message, senderId: activeSender.name });
      } catch (error) {
        db.exec('BEGIN IMMEDIATE');
        try { db.prepare('UPDATE wallets SET credits = credits + ?, updated_at = ? WHERE user_id = ?').run(count, now(), user.id); db.prepare('UPDATE campaigns SET status = ? WHERE id = ? AND user_id = ?').run('Failed', campaignId, user.id); db.exec('COMMIT'); } catch (refundError) { db.exec('ROLLBACK'); throw refundError; }
        return json(res, 502, { error: `SMS was not accepted by Sailup: ${error.message}` });
      }
      const providerMessageIds = Array.isArray(providerResponse.messages) ? providerResponse.messages.map((item) => item.id).filter(Boolean) : [];
      db.prepare('UPDATE campaigns SET status = ?, provider_message_ids = ? WHERE id = ? AND user_id = ?').run('Queued', JSON.stringify(providerMessageIds), campaignId, user.id);
      return json(res, 201, { wallet: wallet(user.id), campaign: { id: campaignId, name, audience, recipients: count, creditsUsed: count, status: 'Queued', provider: 'sailup', providerMessageIds } });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, 500, { error: error.message }); }
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const hasProductionBuild = async () => { try { await access(join(distRoot, 'index.html')); return true; } catch { return false; } };
const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/api/')) return route(req, res);
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const servingDist = process.env.SERVE_DIST === 'true' || await hasProductionBuild();
  const staticRoot = servingDist ? distRoot : root;
  const file = join(staticRoot, requested.replace(/^\//, ''));
  try {
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    if (servingDist && !extname(requested)) {
      try { const content = await readFile(join(distRoot, 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(content); } catch {}
    }
    json(res, 404, { error: 'Not found' });
  }
});
server.listen(Number(process.env.PORT || 3000), () => console.log('reach server running at http://localhost:3000'));
