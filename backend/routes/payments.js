const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { verifyToken } = require('../utils/verifyToken');

// ✅ Create a payment session (Attorney Payment)
router.post('/create-checkout-session', verifyToken, async (req, res) => {
  try {
    if (req.user.role !== 'attorney') {
      return res.status(403).json({ msg: 'Only attorneys can make payments' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Case Submission Fee',
              description: 'Submit a case to hire a certified paralegal.'
            },
            unit_amount: 5000, // $50.00
          },
          quantity: 1
        }
      ],
      success_url: 'http://localhost:5000/payment-success.html',
      cancel_url: 'http://localhost:5000/payment-cancel.html',
      metadata: { userId: req.user.id }
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Stripe error' });
  }
});

// ✅ Fix: Export the router!
module.exports = router;
