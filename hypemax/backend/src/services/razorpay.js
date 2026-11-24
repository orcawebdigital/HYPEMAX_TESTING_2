const crypto = require("crypto");
const config = require("../config");
const { HttpError, safeEqual } = require("../util");

let sdk = null;
let override = null; // tests can inject a fake API client; never used in the app itself

function api() {
  if (override) return override;
  if (!config.features.razorpay) throw new HttpError(503, "Online payments are not configured yet. Please contact us on WhatsApp to order.", "RAZORPAY_MISSING");
  if (!sdk) {
    const Razorpay = require("razorpay");
    sdk = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  }
  return sdk;
}

const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");

/** Checkout signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret) */
function verifyPaymentSignature(orderId, paymentId, signature) {
  if (!config.razorpay.keySecret || !orderId || !paymentId || !signature) return false;
  return safeEqual(hmac(config.razorpay.keySecret, `${orderId}|${paymentId}`), String(signature));
}
/** Webhook signature: HMAC_SHA256(raw_body, webhook_secret) */
function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpay.webhookSecret || !rawBody || !signature) return false;
  return safeEqual(hmac(config.razorpay.webhookSecret, rawBody), String(signature));
}

const wrapErr = (e) => {
  const msg = e && e.error && e.error.description ? e.error.description : e.message || "Razorpay request failed";
  return new HttpError(502, "Payment gateway error: " + msg, "RAZORPAY_ERROR");
};

module.exports = {
  keyId: () => config.razorpay.keyId,
  enabled: () => !!override || config.features.razorpay,
  verifyPaymentSignature,
  verifyWebhookSignature,
  async createOrder(amountPaise, receipt, notes) {
    try { return await api().orders.create({ amount: amountPaise, currency: "INR", receipt, notes, payment_capture: 1 }); }
    catch (e) { throw wrapErr(e); }
  },
  async fetchPayment(paymentId) {
    try { return await api().payments.fetch(paymentId); } catch (e) { throw wrapErr(e); }
  },
  async fetchOrderPayments(orderId) {
    try { const r = await api().orders.fetchPayments(orderId); return r.items || []; } catch (e) { throw wrapErr(e); }
  },
  async capture(paymentId, amount) {
    try { return await api().payments.capture(paymentId, amount, "INR"); } catch (e) { throw wrapErr(e); }
  },
  async refund(paymentId, amountPaise, notes) {
    try { return await api().payments.refund(paymentId, { amount: amountPaise, speed: "normal", notes }); }
    catch (e) { throw wrapErr(e); }
  },
  /** Authenticated read-only call used by the integrations check. */
  async ping() { await api().orders.all({ count: 1 }); return true; },
  _setTestClient(c) { override = c; },
};
