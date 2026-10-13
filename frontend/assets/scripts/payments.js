// frontend/assets/scripts/payments.js

let __stripe = null;
let __pk = null;
let __stripeJsPromise = null;
const STRIPE_JS_SRC = "https://js.stripe.com/v3/";

export function loadStripeJs() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (__stripeJsPromise) return __stripeJsPromise;

  __stripeJsPromise = new Promise((resolve, reject) => {
    let script = document.querySelector('script[src^="https://js.stripe.com/v3"]');
    const created = !script;
    const timeout = window.setTimeout(() => {
      if (created) script?.remove();
      reject(new Error("The Stripe payment form took too long to load. Please try again."));
    }, 20_000);
    const finish = () => {
      window.clearTimeout(timeout);
      if (window.Stripe) resolve(window.Stripe);
      else reject(new Error("We couldn't load the Stripe payment form. Please allow js.stripe.com or disable ad blockers and try again."));
    };
    const fail = () => {
      window.clearTimeout(timeout);
      if (created) script?.remove();
      reject(new Error("We couldn't load the Stripe payment form. Please allow js.stripe.com or disable ad blockers and try again."));
    };

    if (!script) {
      script = document.createElement("script");
      script.src = STRIPE_JS_SRC;
      script.async = true;
      script.dataset.lpcStripeJs = "true";
    }
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", fail, { once: true });
    if (created) document.head.appendChild(script);
  }).catch((error) => {
    __stripeJsPromise = null;
    throw error;
  });

  return __stripeJsPromise;
}

/**
 * Fetch publishable key from /api/payments/config and return a cached Stripe instance.
 */
export async function getStripe() {
  if (__stripe) return __stripe;

  await loadStripeJs();

  const r = await fetch('/api/payments/config', { credentials: 'include' });
  const cfg = r.ok ? await r.json() : {};
  if (!cfg.publishableKey) throw new Error('Missing Stripe publishable key (check /api/payments/config).');
  __pk = cfg.publishableKey;

  if (!window.Stripe) {
    throw new Error("We couldn't load the Stripe payment form. Please allow js.stripe.com or disable ad blockers and try again.");
  }

  __stripe = window.Stripe(__pk);
  return __stripe;
}

/**
 * Ensure a PaymentIntent exists for the case and return its client_secret.
 * Pass in your authenticated fetch (e.g., secureFetch from auth.js) so cookies/CSRF are handled.
 */
export async function ensureIntent(caseId, secureFetch, idemKey) {
  if (!caseId) throw new Error('caseId required');
  const headers = idemKey ? { 'X-Idempotency-Key': idemKey } : undefined;
  const res = await secureFetch(`/api/payments/intent/${encodeURIComponent(caseId)}`, {
    method: 'POST',
    headers
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.clientSecret) throw new Error(data.error || 'Could not create PaymentIntent');
  return data.clientSecret;
}
export async function createElements(clientSecret, appearance = { theme: 'stripe' }) {
  if (!clientSecret) throw new Error('clientSecret required');
  const stripe = await getStripe();
  const options = appearance ? { clientSecret, appearance } : { clientSecret };
  return stripe.elements(options);
}

/**
 * Mount the Payment Element into a container (node or selector). Returns the created element.
 */
export function mountPaymentElement(elements, container) {
  const host = typeof container === 'string' ? document.querySelector(container) : container;
  if (!host) throw new Error('Mount container not found');
  host.innerHTML = '';
  host.style.display = '';
  const el = elements.create('payment');
  el.mount(host);
  return el;
}

/**
 * Confirm the payment. Returns { error, paymentIntent } like Stripe.js.
 */
export async function confirmPayment(elements) {
  const stripe = await getStripe();
  return stripe.confirmPayment({ elements, redirect: 'if_required' });
}

/**
 * Confirm a SetupIntent for saving a payment method.
 */
export async function confirmSetup(elements) {
  const stripe = await getStripe();
  return stripe.confirmSetup({ elements, redirect: 'if_required' });
}
