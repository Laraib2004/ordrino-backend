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
		// Step 1: Capture the PaymentIntent
		const paymentIntent = await stripe.paymentIntents.capture(payment_intent_id);
		console.log(`PaymentIntent ${paymentIntent.id} captured. Status: ${paymentIntent.status}`);

		// Step 2: Get amount and customer info
		const { amount, currency, customer, description } = paymentIntent;

		let invoiceCustomer = customer;
		if (!invoiceCustomer) {
			// If customer is not set on PaymentIntent, create a default one
			const tempCustomer = await stripe.customers.create({
				email: 'anonymous@yourdomain.com',
				name: 'Card',
			});
			invoiceCustomer = tempCustomer.id;
		}

		// Step 3: Create invoice item
		await stripe.invoiceItems.create({
			customer: invoiceCustomer,
			amount: amount, // Already in cents
			currency: currency || 'eur',
			description: description || 'Captured card payment',
		});

		// Step 4: Create invoice (include invoice items)
		let invoice = await stripe.invoices.create({
			customer: invoiceCustomer,
			collection_method: 'send_invoice',
			days_until_due: 0,
			pending_invoice_items_behavior: 'include', // Include previously created invoice items
			metadata: {
				source: 'card',
				linked_payment_intent: paymentIntent.id,
			},
		});

		// Step 5: Finalize and mark as paid (optional, since card payment already completed)
		invoice = await stripe.invoices.finalizeInvoice(invoice.id);
		if (invoice.status !== 'paid') {
			await stripe.invoices.pay(invoice.id, {
				paid_out_of_band: true, // Tells Stripe this is already paid externally
			});
		}

		// Step 6: Return invoice info
		const paidInvoice = await stripe.invoices.retrieve(invoice.id);
		res.json({
			status: paymentIntent.status,
			invoice_id: paidInvoice.id,
			hosted_invoice_url: paidInvoice.hosted_invoice_url,
			invoice_pdf: paidInvoice.invoice_pdf,
		});
	} catch (error) {
		console.error('Error capturing PaymentIntent and creating invoice:', error);
		res.status(500).json({ error: error.message });
	}
});


app.post('/cash_payment', async (req, res) => {
	const { items = [], currency = 'eur', metadata = {} } = req.body;

	if (!Array.isArray(items) || items.length === 0) {
		return res.status(400).json({ error: 'At least one item is required.' });
	}

	try {
		const anonymousCustomerEmail = 'anonymous@yourdomain.com';

		// Get or create "anonymous" customer
		const customers = await stripe.customers.list({ email: anonymousCustomerEmail, limit: 1 });
		let customer = customers.data[0];

		if (!customer) {
			customer = await stripe.customers.create({
				name: 'Walk-in Customer',
				email: anonymousCustomerEmail,
				address: {
					country: 'IT',
					postal_code: "39100"
				},
				metadata: {
					type: 'anonymous',
					tax_code: 'N/A',
					...metadata,
				},
			});
		}

		// Calculate tax amounts manually first
		const taxDetails = items.reduce((acc, item) => {
			const rate = item.item_type === 'reduced' ? 5 :
				item.item_type === 'super_reduced' ? 4 : 10;
			const unitTax = Math.round((Number(item.unit_price) * rate / (100 + rate)));
			const totalTax = unitTax * item.quantity;

			return {
				...acc,
				totalTax: acc.totalTax + totalTax,
				items: [
					...acc.items,
					{
						...item,
						unit_tax: unitTax,
						rate
					}
				]
			};
		}, { totalTax: 0, items: [] });

		// Create tax rates and invoice items
		for (const item of taxDetails.items) {
			let taxRate = await stripe.taxRates.list({
				active: true,
				inclusive: true,
				percentage: item.rate,
				country: 'IT',
				limit: 1
			});

			if (!taxRate.data.length) {
				taxRate = await stripe.taxRates.create({
					display_name: `IVA ${item.rate}%`,
					description: `Italian VAT ${item.rate}%`,
					percentage: item.rate,
					inclusive: true,
					country: 'IT',
					jurisdiction: 'Italy',
				});
			} else {
				taxRate = taxRate.data[0];
			}

			await stripe.invoiceItems.create({
				customer: customer.id,
				currency,
				description: item.name,
				quantity: item.quantity,
				unit_amount_decimal: item.unit_price.toString(),
				tax_rates: [taxRate.id],
			});
		}

		// Create invoice
		let invoice = await stripe.invoices.create({
			customer: customer.id,
			collection_method: 'send_invoice',
			days_until_due: 0,
			pending_invoice_items_behavior: 'include',
			footer: "Importi IVA inclusa ai sensi dell'Art. 13 DPR 633/72",
			metadata: {
				payment_type: 'cash',
				beneficiary_code: '0000000',
				tax_code: 'N/A',
				...metadata,
			},
		});

		invoice = await stripe.invoices.finalizeInvoice(invoice.id);

		// Pay manually (out-of-band)
		if (invoice.status !== 'paid') {
			await stripe.invoices.pay(invoice.id, {
				paid_out_of_band: true,
			});
		}

		const paidInvoice = await stripe.invoices.retrieve(invoice.id, {
			expand: ['total_tax_amounts.tax_rate'],
		});

		// Calculate expected values
		const expectedTotal = items.reduce((sum, item) =>
			sum + (Number(item.unit_price) * item.quantity, 0));
		const expectedTax = taxDetails.totalTax;

		res.json({
			invoice_id: paidInvoice.id,
			hosted_invoice_url: paidInvoice.hosted_invoice_url,
			invoice_pdf: paidInvoice.invoice_pdf,
			total: (expectedTotal / 100).toFixed(2),
			total_tax: (expectedTax / 100).toFixed(2),
			tax_inclusive: true,
			tax_breakdown: taxDetails.items.map(item => ({
				description: item.name,
				quantity: item.quantity,
				unit_price: (Number(item.unit_price) / 100).toFixed(2),
				rate: item.rate,
				tax_per_unit: (item.unit_tax / 100).toFixed(2),
				total_tax: (item.unit_tax * item.quantity / 100).toFixed(2)
			})),
			stripe_tax: (paidInvoice.tax / 100).toFixed(2) // For verification
		});

	} catch (error) {
		console.error('Error creating cash payment invoice:', error);
		res.status(500).json({
			error: error.message,
			code: error.code || 'payment_error'
		});
	}
});

// Start the server
app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
	console.log('Remember to set your STRIPE_SECRET_KEY in a .env file!');
});
