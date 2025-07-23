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
	const { payment_intent_id, items = [], currency = 'eur',
		// Business Information
		business_address,
		business_city,
		business_country,
		business_name,
		province,
		recipient_code,
		business_vat,
		// Customer Information
		customer_name = "Cliente al dettaglio",
		customer_address = "N/A",
		customer_city = "N/A",
		customer_postal_code = "00000",
		customer_country = "IT",
		customer_vat = "N/A",
		customer_fiscal_code = "N/A",
		// Dates (now in DD-MM-YYYY HH:mm format)
		issue_date = formatDate(new Date(), 'DD-MM-YYYY HH:mm'),
		payment_date = formatDate(new Date(), 'DD-MM-YYYY HH:mm'),
		service_date = formatDate(new Date(), 'DD-MM-YYYY HH:mm'),
	 } = req.body;
	console.log(`Received request to capture PaymentIntent: ${payment_intent_id}`);

	// Helper function to format dates
	function formatDate(date, format) {
		const pad = num => num.toString().padStart(2, '0');
		return format
			.replace('DD', pad(date.getDate()))
			.replace('MM', pad(date.getMonth() + 1))
			.replace('YYYY', date.getFullYear())
			.replace('HH', pad(date.getHours()))
			.replace('mm', pad(date.getMinutes()));
	}

	if (!payment_intent_id) {
		return res.status(400).json({ error: 'Payment Intent ID is required.' });
	}

	if (!Array.isArray(items) || items.length === 0) {
		return res.status(400).json({ error: 'At least one item is required.' });
	}

	const requiredBusinessFields = [
		'business_address', 'business_city', 'business_country',
		'business_name', 'business_vat', 'recipient_code'
	];
	const missingFields = requiredBusinessFields.filter(field => !req.body[field]);

	if (missingFields.length > 0) {
		return res.status(400).json({
			error: 'Missing required business fields',
			missing_fields: missingFields
		});
	}

	try {
		const anonymousCustomerEmail = 'anonymous_card@yourdomain.com';
		const paymentIntent = await stripe.paymentIntents.capture(payment_intent_id);
		// Create or retrieve customer
		let customer;
		try {
			const customers = await stripe.customers.list({ email: anonymousCustomerEmail, limit: 1 });
			customer = customers.data[0] || await stripe.customers.create({
				email: anonymousCustomerEmail,
				name: customer_name,
				address: {
					line1: customer_address,
					city: customer_city,
					postal_code: customer_postal_code,
					state: province,
					country: customer_country
				},
				metadata: {
					fiscal_code: customer_fiscal_code,
					vat_number: customer_vat,
					invoice_type: 'B2C'
				}
			});
		} catch (error) {
			console.error('Customer creation failed:', error);
			throw new Error('Failed to create customer record');
		}


		// Create invoice items with proper period handling
		try {
			for (const item of items) {
				// Search for matching Stripe product
				const stripeProducts = await stripe.products.search({
					query: `active:\'true\' AND name:\'${item.name}\'`,
					limit: 1
				});

				if (!stripeProducts.data[0]) {
					throw new Error(`Product "${item.name}" not found in Stripe`);
				}

				// Get the default price for this product
				const prices = await stripe.prices.list({
					product: stripeProducts.data[0].id,
					limit: 1
				});

				if (!prices.data[0]) {
					throw new Error(`No price found for product "${item.name}"`);
				}

				// Parse service date safely
				let serviceTimestamp;
				try {
					const dateString = item.service_date || service_date;
					const [datePart, timePart] = dateString.split(' ');
					const [day, month, year] = datePart.split('-');
					const [hours, minutes] = timePart.split(':');
					const dateObj = new Date(`${year}-${month}-${day}T${hours}:${minutes}:00`);

					if (isNaN(dateObj.getTime())) {
						throw new Error('Invalid date format');
					}
					serviceTimestamp = Math.floor(dateObj.getTime() / 1000);
				} catch (e) {
					console.error(`Invalid service date format: ${item.service_date || service_date}`);
					serviceTimestamp = Math.floor(Date.now() / 1000); // Fallback to current time
				}

				await stripe.invoiceItems.create({
					customer: customer.id,
					pricing: {
						price: prices.data[0].id
					},
					quantity: item.quantity,
					period: {
						start: serviceTimestamp,
						end: serviceTimestamp
					},
					metadata: {
						service_date: item.service_date || service_date
					}
				});
			}
		} catch (error) {
			console.error('Invoice items creation failed:', error);
			throw new Error('Failed to create invoice items: ' + error.message);
		}

		// Create and finalize invoice
		let invoice;
		try {
			invoice = await stripe.invoices.create({
				customer: customer.id,
				collection_method: 'send_invoice',
				days_until_due: 0,
				auto_advance: false, // Don't attempt collection
				automatic_tax: { enabled: true }, // This is critical for total VAT
				description: 'Tap to Pay payment',
				pending_invoice_items_behavior: 'include',
				footer: [
					`Importi IVA inclusa ai sensi dell'Art. 13 DPR 633/72`,
					`Beneficiario: ${recipient_code}`,
					`P.IVA: ${business_vat}`,
					`${business_name} - ${business_address}, ${business_city} (${province})`
				].join('\n'),
				metadata: {
					payment_intent: payment_intent_id, // Reference
					payment_collected_via: 'terminal',
					business_name,
					business_address,
					business_city,
					business_province: province,
					business_country,
					business_vat,
					recipient_code,
					issue_date,
					payment_date,
					payment_type: 'card',
					customer_name,
					customer_vat,
					customer_fiscal_code
				},
				custom_fields: [
					{ name: "Codice SDI", value: recipient_code },
					{ name: "P.IVA", value: business_vat },
					{ name: "Data Emissione", value: issue_date },
					{ name: "Data Pagamento", value: payment_date }
				]
			});

			invoice = await stripe.invoices.attachPayment(
				invoice.id,
				{
					payment_intent: payment_intent_id,
					expand: ['payments'],
				}
			);


			invoice = await stripe.invoices.finalizeInvoice(invoice.id);
			/*if (invoice.status !== 'paid') {
				await stripe.invoices.pay(invoice.id, {
					paid_out_of_band: true
				});
			}*/

			// Update PaymentIntent with invoice reference
			await stripe.paymentIntents.update(payment_intent_id, {
				metadata: {
					invoice_id: invoice.id,
					invoice_number: invoice.number
				}
			});

			res.json({
				status: paymentIntent.status,
				success: true,
				invoice_id: invoice.id,
				hosted_invoice_url: invoice.hosted_invoice_url,
				invoice_pdf: invoice.invoice_pdf,
			});

		} catch (error) {
			console.error('Invoice processing failed:', error);
			throw new Error('Failed to process invoice');
		}

	} catch (error) {
		console.error('Error creating cash payment invoice:', error);
		res.status(500).json({
			error: error.message,
			code: error.code || 'payment_error'
		});
	}
});


app.post('/cash_payment', async (req, res) => {
	const {
		items = [],
		currency = 'eur',
		// Business Information
		business_address,
		business_city,
		business_country,
		business_name,
		province,
		recipient_code,
		business_vat,
		// Customer Information
		customer_name = "Cliente al dettaglio",
		customer_address = "N/A",
		customer_city = "N/A",
		customer_postal_code = "00000",
		customer_country = "IT",
		customer_vat = "N/A",
		customer_fiscal_code = "N/A",
		// Dates (now in DD-MM-YYYY HH:mm format)
		issue_date = formatDate(new Date(), 'DD-MM-YYYY HH:mm'),
		payment_date = formatDate(new Date(), 'DD-MM-YYYY HH:mm'),
		service_date = formatDate(new Date(), 'DD-MM-YYYY HH:mm'),
	} = req.body;

	// Helper function to format dates
	function formatDate(date, format) {
		const pad = num => num.toString().padStart(2, '0');
		return format
			.replace('DD', pad(date.getDate()))
			.replace('MM', pad(date.getMonth() + 1))
			.replace('YYYY', date.getFullYear())
			.replace('HH', pad(date.getHours()))
			.replace('mm', pad(date.getMinutes()));
	}

	// Input validation
	if (!Array.isArray(items) || items.length === 0) {
		return res.status(400).json({ error: 'At least one item is required.' });
	}

	const requiredBusinessFields = [
		'business_address', 'business_city', 'business_country',
		'business_name', 'business_vat', 'recipient_code'
	];
	const missingFields = requiredBusinessFields.filter(field => !req.body[field]);

	if (missingFields.length > 0) {
		return res.status(400).json({
			error: 'Missing required business fields',
			missing_fields: missingFields
		});
	}

	try {
		const anonymousCustomerEmail = 'anonymous@yourdomain.com';

		// Create or retrieve customer
		let customer;
		try {
			const customers = await stripe.customers.list({ email: anonymousCustomerEmail, limit: 1 });
			customer = customers.data[0] || await stripe.customers.create({
				email: anonymousCustomerEmail,
				name: customer_name,
				address: {
					line1: customer_address,
					city: customer_city,
					postal_code: customer_postal_code,
					state: province,
					country: customer_country
				},
				metadata: {
					fiscal_code: customer_fiscal_code,
					vat_number: customer_vat,
					invoice_type: 'B2C'
				}
			});
		} catch (error) {
			console.error('Customer creation failed:', error);
			throw new Error('Failed to create customer record');
		}

		// Create invoice items with proper period handling
		try {
			for (const item of items) {
				// Search for matching Stripe product
				const stripeProducts = await stripe.products.search({
					query: `active:\'true\' AND name:\'${item.name}\'`,
					limit: 1
				});

				if (!stripeProducts.data[0]) {
					throw new Error(`Product "${item.name}" not found in Stripe`);
				}

				// Get the default price for this product
				const prices = await stripe.prices.list({
					product: stripeProducts.data[0].id,
					limit: 1
				});

				if (!prices.data[0]) {
					throw new Error(`No price found for product "${item.name}"`);
				}

				// Parse service date safely
				let serviceTimestamp;
				try {
					const dateString = item.service_date || service_date;
					const [datePart, timePart] = dateString.split(' ');
					const [day, month, year] = datePart.split('-');
					const [hours, minutes] = timePart.split(':');
					const dateObj = new Date(`${year}-${month}-${day}T${hours}:${minutes}:00`);

					if (isNaN(dateObj.getTime())) {
						throw new Error('Invalid date format');
					}
					serviceTimestamp = Math.floor(dateObj.getTime() / 1000);
				} catch (e) {
					console.error(`Invalid service date format: ${item.service_date || service_date}`);
					serviceTimestamp = Math.floor(Date.now() / 1000); // Fallback to current time
				}

				await stripe.invoiceItems.create({
					customer: customer.id,
					pricing: {
						price: prices.data[0].id},
					quantity: item.quantity,
					period: {
						start: serviceTimestamp,
						end: serviceTimestamp
					},
					metadata: {
						service_date: item.service_date || service_date
					}
				});
			}
		} catch (error) {
			console.error('Invoice items creation failed:', error);
			throw new Error('Failed to create invoice items: ' + error.message);
		}

		// Create and finalize invoice with automatic tax
		let invoice;
		try {
			invoice = await stripe.invoices.create({
				customer: customer.id,
				collection_method: 'send_invoice',
				days_until_due: 0,
				automatic_tax: { enabled: true }, // Enable automatic tax calculation
				description: 'Pagamento contanti',
				pending_invoice_items_behavior: 'include',
				footer: [
					`Importi IVA inclusa ai sensi dell'Art. 13 DPR 633/72`,
					`Beneficiario: ${recipient_code}`,
					`P.IVA: ${business_vat}`,
					`${business_name} - ${business_address}, ${business_city} (${province})`
				].join('\n'),
				metadata: {
					business_name,
					business_address,
					business_city,
					business_province: province,
					business_country,
					business_vat,
					recipient_code,
					issue_date,
					payment_date,
					payment_type: 'cash',
					customer_name,
					customer_vat,
					customer_fiscal_code
				},
				custom_fields: [
					{ name: "Codice SDI", value: recipient_code },
					{ name: "P.IVA", value: business_vat },
					{ name: "Data Emissione", value: issue_date },
					{ name: "Data Pagamento", value: payment_date }
				]
			});

			invoice = await stripe.invoices.finalizeInvoice(invoice.id);
			if (invoice.status !== 'paid') {
				await stripe.invoices.pay(invoice.id, {
					paid_out_of_band: true,
				});
			}

			// Format response with tax details from Stripe
			res.json({
				success: true,
				invoice_id: invoice.id,
				hosted_invoice_url: invoice.hosted_invoice_url,
				invoice_pdf: invoice.invoice_pdf
			});

		} catch (error) {
			console.error('Invoice processing failed:', error);
			throw new Error('Failed to process invoice');
		}

	} catch (error) {
		console.error('Invoice creation error:', {
			message: error.message,
			stack: error.stack
		});

		res.status(500).json({
			error: 'Invoice creation failed',
			message: error.message,
			code: error.code || 'invoice_error'
		});
	}
});

// Start the server
app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
	console.log('Remember to set your STRIPE_SECRET_KEY in a .env file!');
});
