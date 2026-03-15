const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Configuration & Environment ---
function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const config = {
  port: Number(process.env.ORCHESTRATOR_PORT || 3000),
  paymentUrl: readRequiredEnv('PAYMENT_URL'),
  inventoryUrl: readRequiredEnv('INVENTORY_URL'),
  shippingUrl: readRequiredEnv('SHIPPING_URL'),
  notificationUrl: readRequiredEnv('NOTIFICATION_URL'),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 2500)
};

const DATA_DIR = '/data';
const IDEMPOTENCY_STORE_PATH = path.join(DATA_DIR, 'idempotency-store.json');
const SAGA_STORE_PATH = path.join(DATA_DIR, 'saga-store.json');

// --- Persistence Helpers ---
function ensureJsonFile(filePath, initialData) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

// --- Utility Functions ---
const nowIso = () => new Date().toISOString();
const payloadHash = (p) => `sha256:${crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex')}`;

function validateCheckoutPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'Request body must be a JSON object';
  const required = ['orderId', 'items', 'amount', 'recipient'];
  for (const field of required) {
    if (!payload[field]) return `Field "${field}" is required`;
  }
  return null;
}

// --- State Management ---
function upsertIdempotencyRecord(key, record) {
  const store = readJsonFile(IDEMPOTENCY_STORE_PATH);
  store.records = store.records || {};
  store.records[key] = { ...record, updatedAt: nowIso() };
  writeJsonFile(IDEMPOTENCY_STORE_PATH, store);
}

function upsertSagaRecord(orderId, key, state, trace) {
  const store = readJsonFile(SAGA_STORE_PATH);
  store.sagas = store.sagas || {};
  // Changed "trace" to "steps: trace" below
  store.sagas[orderId] = { idempotencyKey: key, state, steps: trace, updatedAt: nowIso() };
  writeJsonFile(SAGA_STORE_PATH, store);
}


// --- Orchestration Core ---
async function callStep({ trace, step, url, payload, headers }) {
  const startedAt = nowIso();
  const startTime = Date.now();
  try {
    const response = await axios.post(url, payload, {
      headers,
      timeout: config.requestTimeoutMs,
      validateStatus: () => true // Allow us to handle 4xx/5xx manually
    });

    const durationMs = Date.now() - startTime;
    const isTimeout = response.status === 408 || response.status === 504;
    const status = (response.status >= 200 && response.status < 300) ? 'success' : (isTimeout ? 'timeout' : 'failure');

    trace.push({ step, status, startedAt, finishedAt: nowIso(), durationMs });

    return { ok: status === 'success', status, response };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const isTimeout = err.code === 'ECONNABORTED';
    const status = isTimeout ? 'timeout' : 'failure';

    trace.push({ step, status, startedAt, finishedAt: nowIso(), durationMs });
    return { ok: false, status, error: err };
  }
}

async function runCompensation(trace, orderId, headers, stepsToUndo) {
  // Compensation is executed in reverse order of the forward flow
  if (stepsToUndo.inventory) {
    const res = await callStep({
      trace, step: 'inventory_release', url: `${config.inventoryUrl}/inventory/release`,
      payload: { orderId }, headers
    });
    if (!res.ok) return false;
  }
  if (stepsToUndo.payment) {
    const res = await callStep({
      trace, step: 'payment_refund', url: `${config.paymentUrl}/payment/refund`,
      payload: { orderId }, headers
    });
    if (!res.ok) return false;
  }
  return true;
}

// --- API Endpoints ---
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/checkout', async (req, res) => {
  const key = req.header('Idempotency-Key');
  if (!key) return res.status(400).json({ code: 'validation_error', message: 'Idempotency-Key required' });

  const error = validateCheckoutPayload(req.body);
  if (error) return res.status(400).json({ code: 'validation_error', message: error });

  const currentHash = payloadHash(req.body);
  const idemStore = readJsonFile(IDEMPOTENCY_STORE_PATH);
  const existing = (idemStore.records || {})[key];

  // 1. Idempotency Check
  if (existing) {
    if (existing.requestHash !== currentHash) {
      return res.status(409).json({ code: 'idempotency_payload_mismatch' });
    }
    if (existing.state === 'in_progress') {
      return res.status(409).json({ code: 'idempotency_conflict' });
    }
    return res.status(existing.httpStatus).json(existing.response);
  }

  // 2. Initial Persist
  const orderId = req.body.orderId;
  upsertIdempotencyRecord(key, { requestHash: currentHash, state: 'in_progress' });

  const trace = [];
  const headers = { 'x-correlation-id': key, 'x-order-id': orderId };
  const sagaState = { payment: false, inventory: false };

  const finalize = (status, bizStatus, code = null) => {
    const responseBody = { orderId, status: bizStatus, trace };
    if (code) responseBody.code = code;
    
    upsertSagaRecord(orderId, key, bizStatus, trace);
    upsertIdempotencyRecord(key, { requestHash: currentHash, state: bizStatus, httpStatus: status, response: responseBody });
    return res.status(status).json(responseBody);
  };

  // --- Step 1: Payment ---
  const pRes = await callStep({
    trace, step: 'payment', url: `${config.paymentUrl}/payment/authorize`,
    payload: { orderId, amount: req.body.amount }, headers
  });

  if (!pRes.ok) {
    if (pRes.status === 'timeout') return finalize(504, 'failed', 'timeout');
    return finalize(422, 'failed', pRes.response?.data?.code || 'payment_failed');
  }
  sagaState.payment = true;

  // --- Step 2: Inventory ---
  const iRes = await callStep({
    trace, step: 'inventory', url: `${config.inventoryUrl}/inventory/reserve`,
    payload: { orderId, items: req.body.items }, headers
  });

  if (!iRes.ok) {
    const compOk = await runCompensation(trace, orderId, headers, { payment: true });
    if (!compOk) return finalize(422, 'failed', 'compensation_failed');
    if (iRes.status === 'timeout') return finalize(504, 'compensated', 'timeout');
    return finalize(422, 'compensated', iRes.response?.data?.code || 'inventory_failed');
  }
  sagaState.inventory = true;

  // --- Step 3: Shipping ---
  const sRes = await callStep({
    trace, step: 'shipping', url: `${config.shippingUrl}/shipping/create`,
    payload: { orderId }, headers
  });

  if (!sRes.ok) {
    const compOk = await runCompensation(trace, orderId, headers, { inventory: true, payment: true });
    if (!compOk) return finalize(422, 'failed', 'compensation_failed');
    if (sRes.status === 'timeout') return finalize(504, 'compensated', 'timeout');
    return finalize(422, 'compensated', sRes.response?.data?.code || 'shipping_failed');
  }

  // --- Step 4: Notification (Final) ---
  const nRes = await callStep({
    trace, step: 'notification', url: `${config.notificationUrl}/notification/send`,
    payload: { orderId, recipient: req.body.recipient }, headers
  });

  if (!nRes.ok) {
    // If notification fails, business rules say we must still compensate earlier steps
    const compOk = await runCompensation(trace, orderId, headers, { inventory: true, payment: true });
    if (!compOk) return finalize(422, 'failed', 'compensation_failed');
    if (nRes.status === 'timeout') return finalize(504, 'compensated', 'timeout');
    return finalize(422, 'compensated', nRes.response?.data?.code || 'notification_failed');
  }

  return finalize(200, 'completed');
});

// Bootstrap & Start
ensureJsonFile(IDEMPOTENCY_STORE_PATH, { records: {} });
ensureJsonFile(SAGA_STORE_PATH, { sagas: {} });

app.listen(config.port, () => {
  console.log(`Orchestrator online on port ${config.port}`);
});