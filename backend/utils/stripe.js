const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Creates a Stripe Checkout session for one-time payment.
 * @param {String} userId - ID of the attorney
 * @param {String} successURL - URL to redirect on payment success
 * @param {String} cancelURL - URL to redirect on payment cancel
 */
async function createCheckoutSession(userId, successURL, cancelURL) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    customer_email: '', // optional: pre-fill customer email
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'ParaConnect Case Post',
            description: 'Submit a case and connect with certified paralegals.'
          },
          unit_amount: 5000 // $50.00
        },
        quantity: 1
      }
    ],
    metadata: {
      userId
    },
    success_url: successURL,
    cancel_url: cancelURL
  });

  return session;
}

module.exports = {
  createCheckoutSession
};
