// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Initialize Stripe with your secret key
const cors = require('cors'); // For handling Cross-Origin Resource Sharing (useful for local testing)

const app = express();
const PORT = process.env.PORT || 3000; // Use port from environment variable or default to 3000

// Middleware
app.use(cors()); // Enable CORS for all routes (adjust for production security)
app.use(express.json()); // To parse JSON request bodies

// --- Endpoint for ConnectionToken ---
app.post('/connection_token', async (req, res) => {
	console.log('Received request for /connection_token');
	try {
		// Create a ConnectionToken
		// No parameters are typically needed for connection token creation
		const connectionToken = await stripe.terminal.connectionTokens.create();

		// Return the secret to the client
		res.json({ secret: connectionToken.secret });
		console.log('ConnectionToken created and secret sent.');
	} catch (error) {
		console.error('Error creating ConnectionToken:', error);
		res.status(500).json({ error: error.message });
	}
});

// --- Example endpoint for creating a Payment Intent (as discussed previously) ---
// This is just for completeness, you'd integrate your actual payment logic here
app.post('/create_payment_intent', async (req, res) => {
	const { amount, currency = 'eur' } = req.body; // Amount should be in cents
	console.log(`Received request to create PaymentIntent for amount: ${amount}, currency: ${currency}`);

	if (!amount || typeof amount !== 'number' || amount <= 0) {
		return res.status(400).json({ error: 'Amount is required and must be a positive number.' });
	}

	try {
		const paymentIntent = await stripe.paymentIntents.create({
			amount: amount, // Amount in cents
			currency: currency,
			payment_method_types: ['card_present'], // Essential for Terminal payments
			capture_method: 'manual', // Recommended for Terminal to allow explicit capture
		});
		res.json({ client_secret: paymentIntent.client_secret });
		console.log('PaymentIntent created and client_secret sent.');
	} catch (error) {
		console.error('Error creating PaymentIntent:', error);
		res.status(500).json({ error: error.message });
	}
});

// --- Example endpoint for capturing a Payment Intent (as discussed previously) ---
app.post('/capture_payment_intent', async (req, res) => {
	const { payment_intent_id } = req.body;
	console.log(`Received request to capture PaymentIntent: ${payment_intent_id}`);

	if (!payment_intent_id) {
		return res.status(400).json({ error: 'Payment Intent ID is required.' });
	}

	try {
		const paymentIntent = await stripe.paymentIntents.capture(payment_intent_id);
		// You would typically update your order/database here after successful capture
		console.log(`PaymentIntent ${paymentIntent.id} captured. Status: ${paymentIntent.status}`);
		res.json({ status: paymentIntent.status });
	} catch (error) {
		console.error('Error capturing PaymentIntent:', error);
		res.status(500).json({ error: error.message });
	}
});

app.post('/cash_payment', async (req, res) => {
	const { amount, currency = 'eur', description = 'Cash payment', metadata = {} } = req.body;
	console.log('AAAAA:', req.body);
	console.log('BBBBBB:', amount);


	if (!amount || typeof amount !== 'number' || amount <= 0) {
		return res.status(400).json({ error: 'Amount must be a positive number.' });
	}

	try {
		const anonymousCustomerEmail = 'anonymous@yourdomain.com';

		// Reuse or create anonymous customer
		const customers = await stripe.customers.list({ email: anonymousCustomerEmail, limit: 1 });
		let customer = customers.data[0];

		if (!customer) {
			customer = await stripe.customers.create({
				name: 'Walk-in Customer',
				email: anonymousCustomerEmail,
				metadata: { type: 'anonymous' },
			});
		}

		// Create and finalize invoice
		let invoice = await stripe.invoices.create({
			customer: customer.id,
			collection_method: 'send_invoice',
			amount: amount,
			currency: currency,
			description: description,
			days_until_due: 0,
			auto_advance: true,
			metadata: {
				payment_type: 'cash',
				...metadata,
			},
		});

		invoice = await stripe.invoices.finalizeInvoice(invoice.id);

		// 🔒 Only mark as paid if not already paid
		if (invoice.status !== 'paid') {
			await stripe.invoices.pay(invoice.id, {
				paid_out_of_band: true,
			});
		}

		// Retrieve updated invoice
		const paidInvoice = await stripe.invoices.retrieve(invoice.id);

		res.json({
			invoice_id: paidInvoice.id,
			hosted_invoice_url: paidInvoice.hosted_invoice_url,
			invoice_pdf: paidInvoice.invoice_pdf,
		});
	} catch (error) {
		console.error('Error creating cash payment invoice:', error);
		res.status(500).json({ error: error.message });
	}
});




// Start the server
app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
	console.log('Remember to set your STRIPE_SECRET_KEY in a .env file!');
});
