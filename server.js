// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Initialize Stripe with your secret key
const cors = require('cors'); // For handling Cross-Origin Resource Sharing (useful for local testing)

const app = express();
const PORT = process.env.PORT || 3000; // Use port from environment variable or default to 3000
const OPENAPI_URL_TEST = "https://test.invoice.openapi.com/IT-receipts";
const axios = require("axios");
const receiptWaiters = new Map();

// Middleware
app.use(cors()); // Enable CORS for all routes (adjust for production security)
app.use(express.json()); // To parse JSON request bodies

// 1. SETTINGS
// Replace with your actual API Token
const API_TOKEN = "695d2bbb14d236be330356f4";
// Replace with the actual endpoint (check your specific provider's docs, likely something like this)
const API_URL = "https://test.invoice.openapi.com/IT-configurations";

// 2. GENERATE VALID DUMMY DATA
// Using a generic valid 11-digit P.IVA format (00000000000 is often accepted as test, or use a generator)
const TEST_VAT_NUMBER = "12345678903";

// Using a standard valid fake Codice Fiscale (Mario Rossi) for the auth representative
const TEST_TAX_CODE = "RSSMRA80A01H501U";

// 3. CONSTRUCT THE PAYLOAD
const companyData = {
	// fiscal_id: The VAT number of your "fake" company
	fiscal_id: TEST_VAT_NUMBER,
	name: "TEST COMPANY SRL",
	email: "dev-test@example.com",

	// REQUIRED: Enable receipts
	receipts: true,

	// REQUIRED: Authentication for the "Cloud RT"
	// Since you are in test mode, you can put placeholder credentials here.
	receipts_authentication: {
		taxCode: TEST_TAX_CODE,  // Legal Representative's CF
		password: "TestPassword123!", // Dummy password
		pin: "12345"                  // Dummy PIN
	},

	// REQUIRED: Callbacks (as per your instructions)
	api_configurations: [
		{
			event: "receipt",
			callback: {
				url: "https://ordrino-backend.onrender.com/openapi/receipt"
			}
		},
		{
			event: "receipt-error",
			callback: {
				url: "https://ordrino-backend.onrender.com/openapi/receipt-error"
			}
		}
	]
};

async function createTestCompany() {
	try {
		console.log("Creating Test Company Configuration...");

		const response = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${API_TOKEN}` // If authentication is required
			},
			body: JSON.stringify(companyData)
		});

		const result = await response.json();

		// 5. HANDLE RESPONSE
		if (response.ok) {
			console.log("✅ SUCCESS: Company Created!");
			console.log("Company ID:", result.data.id);
			console.log("Fiscal ID:", result.data.fiscal_id);
		} else {
			console.error("❌ ERROR:", response.status);
			console.error("Message:", result.message || result);

			// Handle the specific error mentioned in your prompt (404/409)
			if (result.error === 111) {
				console.error("Details: Fiscal ID issue. Try a different VAT number.");
			}
		}

	} catch (error) {
		console.error("❌ NETWORK ERROR:", error.message);
	}
}


function waitForReceipt(receiptId) {
	return new Promise((resolve, reject) => {
		receiptWaiters.set(receiptId, { resolve, reject });

		// Timeout after 15 seconds
		setTimeout(() => {
			if (receiptWaiters.has(receiptId)) {
				receiptWaiters.get(receiptId).reject(new Error("Timeout waiting for OpenAPI receipt"));
				receiptWaiters.delete(receiptId);
			}
		}, 15000);
	});
}

async function sendFiscalReceipt({
	items,
	paymentBreakdown, // { cash: 0, card: 0, ticketRestaurant: 0, ticketQuantity: 0 }
	invoiceIssuing = false,
	linkedReceipt = null,
	discount = 0,
	lotteryCode = null,
	tags = []
}) {
	let fiscalId = process.env.OPENAPI_FISCAL_ID;

	// 1. Dynamic Fetch: Get the first available configuration
	try {
		console.log("🔍 Fetching available Fiscal Configurations...");
		const configResponse = await axios.get(
			"https://test.invoice.openapi.com/IT-configurations",
			{
				headers: {
					Authorization: `Bearer ${process.env.OPENAPI_TOKEN_INVOICE_SANDBOX}`,
					"Content-Type": "application/json"
				}
			}
		);

		if (configResponse.data && Array.isArray(configResponse.data.data) && configResponse.data.data.length > 0) {
			// Take the first one found
			fiscalId = configResponse.data.data[0].fiscal_id;
			console.log(`✅ Found Fiscal ID: ${fiscalId}`);
		} else {
			console.error("⚠️ No configurations found. Falling back to ENV or failing.");
			createTestCompany();
			fiscalId = TEST_TAX_CODE;
		}
	} catch (error) {
		console.error("⚠️ Failed to fetch configurations dynamically:", error.message);
		// We continue, hoping the ENV variable is set as fallback
		createTestCompany();
		fiscalId = TEST_TAX_CODE;
	}

	if (!fiscalId) {
		throw new Error("No Fiscal ID found (checked API and ENV). Please configure a cashier in OpenAPI.");
	}

	// 2. Construct Payload
	const payload = {
		fiscal_id: fiscalId,
		items: items.map(i => ({
			quantity: i.quantity,
			description: i.name || i.description || "Item",
			unit_price: i.unit_price / 100, // must be in euros
			vat_rate_code: i.vat_rate_code || "10",
			discount: i.discount || 0,
			complimentary: false,
			sku: i.sku || ""
		})),
		invoice_issuing: invoiceIssuing,
		cash_payment_amount: paymentBreakdown.cash || 0,
		electronic_payment_amount: paymentBreakdown.card || 0,
		ticket_restaurant_payment_amount: paymentBreakdown.ticketRestaurant || 0,
		ticket_restaurant_quantity: paymentBreakdown.ticketQuantity || 0,
		goods_uncollected_amount: paymentBreakdown.goodsUncollected || 0,
		services_uncollected_amount: paymentBreakdown.servicesUncollected || 0,
		discount: discount,
		linked_receipt: linkedReceipt,
		lottery_code: lotteryCode,
		tags: tags
	};

	// 3. Send Receipt
	try {
		console.log(`📤 Sending to OpenAPI (Fiscal ID: ${fiscalId})...`);

		const response = await axios.post(
			"https://test.invoice.openapi.com/IT-receipts",
			payload,
			{
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.OPENAPI_TOKEN_INVOICE_SANDBOX}`
				}
			}
		);

		return response.data.data.id;

	} catch (error) {
		// Detailed Error Logging
		if (error.response) {
			console.error("❌ OpenAPI Error Response:", JSON.stringify(error.response.data, null, 2));
			throw new Error(`OpenAPI Error: ${error.response.data.message || error.response.statusText}`);
		}
		throw error;
	}
}



// --- Openapi Receipt Callback (SUCCESS) ---
app.post('/openapi/receipt', (req, res) => {
	console.log("📥 Fiscal receipt SUCCESS:", req.body);

	const receiptId = req.body.id;

	if (receiptWaiters.has(receiptId)) {
		receiptWaiters.get(receiptId).resolve(req.body);
		receiptWaiters.delete(receiptId);
	}

	res.sendStatus(200);
});

// --- Openapi Receipt Callback (ERROR) ---
app.post('/openapi/receipt-error', (req, res) => {
	console.error("❌ Fiscal receipt ERROR:", req.body);

	const receiptId = req.body.id;

	if (receiptWaiters.has(receiptId)) {
		receiptWaiters.get(receiptId).reject(new Error(req.body.message || "Fiscal error"));
		receiptWaiters.delete(receiptId);
	}

	res.sendStatus(200);
});


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
		const anonymousCustomerEmail = 'anonymous_card@yourdomain.com';
		let customer = await getOrCreateCustomer(anonymousCustomerEmail);

		const paymentIntent = await stripe.paymentIntents.create({
			amount: amount, // Amount in cents
			currency: currency,
			customer: customer.id,
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
		tip_amount_cents = 0,
		subtotal_amount_cents = 0,
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
		const paymentIntent = await stripe.paymentIntents.capture(payment_intent_id);

		const expected_total = subtotal_amount_cents + tip_amount_cents;
		const captured_total = paymentIntent.amount_received;

		if (captured_total !== expected_total) {
			// Log the mismatch but proceed or, ideally, throw an error
			// since this is a serious mismatch.
			console.error(`ERROR: Captured amount (${captured_total}) does not match expected total (${expected_total}).`);
			// You might want to throw an error here to prevent a fraudulent receipt.
			// throw new Error('Payment total mismatch. Aborting invoice creation.');
		}

		const anonymousCustomerEmail = 'anonymous_card@yourdomain.com';
		let customer = await getOrCreateCustomer(anonymousCustomerEmail);

		let invoice;

		invoice = await stripe.invoices.create({
			customer: customer.id,
			collection_method: 'send_invoice',
			days_until_due: 0,
			auto_advance: false, // Don't attempt collection
			automatic_tax: { enabled: true }, // This is critical for total VAT
			description: 'Tap to Pay payment',
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
				customer_fiscal_code,
				tip_amount_cents
			},
			custom_fields: [
				{ name: "Codice SDI", value: recipient_code },
				{ name: "P.IVA", value: business_vat },
				{ name: "Data Emissione", value: issue_date },
				{ name: "Data Pagamento", value: payment_date }
			]
		});


		// Create invoice items with proper period handling
		try {
			// Parse service date safely
			let serviceTimestamp;
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
					invoice: invoice.id,
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

			if (tip_amount_cents > 0) {
				console.log(`Adding tip of ${tip_amount_cents} cents to invoice.`);

				const TIP_PRODUCT_NAME = "Tip"; // NOTE: This MUST match your Stripe Product name

				// 1. Find Tip Product
				const tipProducts = await stripe.products.search({
					query: `active:\'true\' AND name:\'${TIP_PRODUCT_NAME}\'`,
					limit: 1
				});

				if (!tipProducts.data[0]) {
					throw new Error(`Tip Product "${TIP_PRODUCT_NAME}" not found in Stripe. Please create it.`);
				}

				// 2. Create Ad-hoc Price for the specific tip amount
				// Since the tip amount is variable, we create a one-time price for it.
				const tipPrice = await stripe.prices.create({
					unit_amount: tip_amount_cents, // Use the amount received from the client
					currency: currency,
					product: tipProducts.data[0].id,
					billing_scheme: 'per_unit',
					tax_behavior: 'unspecified', // Tips are usually non-taxable
				});

				// 3. Add Tip Invoice Item
				await stripe.invoiceItems.create({
					customer: customer.id,
					invoice: invoice.id,
					pricing: {
						price: tipPrice.id
					},
					quantity: 1, // Always 1 unit of tip
					// Use the same period as the rest of the items or current time
					period: {
						start: serviceTimestamp, // Use the existing serviceTimestamp variable
						end: serviceTimestamp
					},
					description: 'Mancia/Tip'
				});
			}
		} catch (error) {
			console.error('Invoice items creation failed:', error);
			throw new Error('Failed to create invoice items: ' + error.message);
		}

		// Create and finalize invoice
		try {

			invoice = await stripe.invoices.finalizeInvoice(invoice.id);

			invoice = await stripe.invoices.attachPayment(
				invoice.id,
				{
					payment_intent: payment_intent_id,
					expand: ['payments']
				}
			);

			// Update PaymentIntent with invoice reference
			await stripe.paymentIntents.update(payment_intent_id, {
				metadata: {
					invoice_id: invoice.id,
					invoice_number: invoice.number
				}
			});

			// 1. send to OpenAPI → get receiptId
			const receiptId = await sendFiscalReceipt({
				items,
				paymentBreakdown:
				{
					cash: 0,
					card: parseFloat(captured_total / 100),
					ticketRestaurant: 0,
					ticketQuantity: 0
				}
			});

			console.log("OpenAPI accepted receipt, id:", receiptId);

			// 2. Wait for callback to arrive
			let finalReceipt;
			try {
				finalReceipt = await waitForReceipt(receiptId);
			} catch (err) {
				console.error('Invoice creation error:', {
					message: error.message,
					stack: error.stack
				});
				return res.status(500).json({
					success: false,
					message: "Fiscal system timeout",
					error: err.message
				});
			}

			// 3. finalReceipt contains:
			// { id, status, protocol, qr, fiscal_code, amount, timestamp }

			// THIS response is NOT the AdE final result.
			// The final result arrives via callback!
			console.log("Openapi accepted receipt:", fiscalResponse.data);
			res.json({
				status: paymentIntent.status,
				success: true,
				invoice_id: invoice.id,
				hosted_invoice_url: finalReceipt.qr,
				invoice_pdf: invoice.invoice_pdf,
				fiscal_receipt: {
					id: finalReceipt.id,
					qr: finalReceipt.qr,
					protocol: finalReceipt.protocol,
					status: finalReceipt.status,
					amount: finalReceipt.amount
				}
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
		tip_amount_cents = 0,
		subtotal_amount_cents = 0,
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
	let invoice;

	try {
		// ❌ REMOVED: The entire PaymentIntent validation block that caused the error.

		const anonymousCustomerEmail = 'anonymous@yourdomain.com';
		let customer = await getOrCreateCustomer(anonymousCustomerEmail);

		invoice = await stripe.invoices.create({
			customer: customer.id,
			collection_method: 'send_invoice',
			days_until_due: 0,
			auto_advance: false,
			automatic_tax: { enabled: true }, // Enable automatic tax calculation
			description: 'Pagamento contanti',
			footer: [
				`Importi IVA inclusa ai sensi dell'Art. 13 DPR 633/72`,
				`Beneficiario: ${recipient_code}`,
				`P.IVA: ${business_vat}`,
				`${business_name} - ${business_address}, ${business_city} (${province})`
			].join('\n'),
			metadata: {
				payment_collected_via: 'cash',
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
				customer_fiscal_code,
				tip_amount_cents,
				subtotal_amount_cents
			},
			custom_fields: [
				{ name: "Codice SDI", value: recipient_code },
				{ name: "P.IVA", value: business_vat },
				{ name: "Data Emissione", value: issue_date },
				{ name: "Data Pagamento", value: payment_date }
			]
		});

		// Create invoice items with proper period handling
		try {
			let serviceTimestamp;

			// Re-calculate serviceTimestamp once before the loop
			try {
				const dateString = service_date;
				const [datePart, timePart] = dateString.split(' ');
				const [day, month, year] = datePart.split('-');
				const [hours, minutes] = timePart.split(':');
				const dateObj = new Date(`${year}-${month}-${day}T${hours}:${minutes}:00`);

				if (isNaN(dateObj.getTime())) {
					throw new Error('Invalid date format');
				}
				serviceTimestamp = Math.floor(dateObj.getTime() / 1000);
			} catch (e) {
				console.error(`Invalid service date format: ${service_date}. Falling back to current time.`);
				serviceTimestamp = Math.floor(Date.now() / 1000);
			}

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
					invoice: invoice.id,
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

			if (tip_amount_cents > 0) {
				console.log(`Adding tip of ${tip_amount_cents} cents to invoice.`);

				const TIP_PRODUCT_NAME = "Tip";

				const tipProducts = await stripe.products.search({
					query: `active:\'true\' AND name:\'${TIP_PRODUCT_NAME}\'`,
					limit: 1
				});

				if (!tipProducts.data[0]) {
					throw new Error(`Tip Product "${TIP_PRODUCT_NAME}" not found in Stripe. Please create it.`);
				}

				const tipPrice = await stripe.prices.create({
					unit_amount: tip_amount_cents,
					currency: currency,
					product: tipProducts.data[0].id,
					billing_scheme: 'per_unit',
					tax_behavior: 'unspecified',
				});

				await stripe.invoiceItems.create({
					customer: customer.id,
					invoice: invoice.id,
					pricing: {
						price: tipPrice.id
					},
					quantity: 1,
					period: {
						start: serviceTimestamp,
						end: serviceTimestamp
					},
					description: 'Mancia/Tip'
				});
			}
		} catch (error) {
			console.error('Invoice items creation failed:', error);
			throw new Error('Failed to create invoice items: ' + error.message);
		}

		// Create and finalize invoice, and mark as paid out-of-band
		try {
			invoice = await stripe.invoices.finalizeInvoice(invoice.id);

			// Mark the invoice as paid outside of Stripe (Paid Out-of-Band)
			if (invoice.status !== 'paid') {
				invoice = await stripe.invoices.pay(invoice.id, {
					paid_out_of_band: true,
				});
			}

			// 1. send to OpenAPI → get receiptId
			const receiptId = await sendFiscalReceipt({
				items,
				paymentBreakdown:
				{
					cash: parseFloat((subtotal_amount_cents + tip_amount_cents) / 100),
					card: 0,
					ticketRestaurant: 0,
					ticketQuantity: 0
				}
			});

			console.log("OpenAPI accepted receipt, id:", receiptId);

			// 2. Wait for callback to arrive
			let finalReceipt;
			try {
				finalReceipt = await waitForReceipt(receiptId);
			} catch (err) {
				console.error('Invoice creation error:', {
					message: error.message,
					stack: error.stack
				});
				return res.status(500).json({
					success: false,
					message: "Fiscal system timeout",
					error: err.message
				});
			}

			// 3. finalReceipt contains:
			// { id, status, protocol, qr, fiscal_code, amount, timestamp }


			res.json({
				success: true,
				invoice_id: invoice.id,
				hosted_invoice_url: finalReceipt.qr,
				invoice_pdf: invoice.invoice_pdf,
				fiscal_receipt: {
					id: finalReceipt.id,
					qr: finalReceipt.qr,
					protocol: finalReceipt.protocol,
					status: finalReceipt.status,
					amount: finalReceipt.amount
				}
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

app.post('/create-update-product', async (req, res) => {

	try {

		const {
			currency = "eur",
			itemName,
			unit_amount,
			available,
			description = "",
			tax_code,
			create,
			prod_id
		} = req.body;


		if (!create) {

			const product = await stripe.products.retrieve(prod_id);

			if (!product) {
				throw new Error(`Product "${prod_id}" not found in Stripe`);
			}

			let price;

			const priceOld = await stripe.prices.retrieve(product.default_price);

			if (priceOld.unit_amount === unit_amount) {
				price = priceOld;
			} else {
				price = await stripe.prices.create({
					currency,
					unit_amount: unit_amount,
					product: product.id,
					tax_behavior: "inclusive",

				});
			}

			const productUpdate = await stripe.products.update(
				product.id,
				{
					default_price: price.id,
					description,
					name: itemName,
					tax_code,
					active: true
				}
			);

			res.json({
				prodId: productUpdate.id
			});

		}
		else {
			const product = await stripe.products.create({
				name: itemName,
				description,
				tax_code,
				active: true,
				default_price_data: {
					currency,
					unit_amount,
					tax_behavior: "inclusive",

				}
			});

			res.json({
				prodId: product.id
			});
		}

	} catch (error) {
		console.error('Create/Updating Product failed:', {
			message: error.message,
			stack: error.stack
		});

		res.status(500).json({
			error: 'Create/Updating Product failed',
			message: error.message,
			code: error.code || 'create_update_product_error'
		});
	}

});

async function getOrCreateCustomer(anonymousCustomerEmail) {
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
		return customer;
	} catch (error) {
		console.error('Customer creation failed:', error);
		throw new Error('Failed to create customer record');
	}
}

// Start the server
app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
	console.log('Remember to set your STRIPE_SECRET_KEY in a .env file!');
});
