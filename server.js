const express = require('express');
const { decrypt } = require('./crypto');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================================
// 1. HELPER: Fiscalization & Polling Logic
// ==========================================
require('dotenv').config();
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
	console.error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT is missing.");
	process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
	credential: admin.credential.cert(serviceAccount)
});

// 3. NOW you can define the DB
const db = admin.firestore();

// ==========================================
// 1. A-CUBE AUTHENTICATION MANAGER
// ==========================================
let acubeTokenCache = null;
let tokenExpirationTime = 0;

async function getAcubeToken(email, password) {
	const now = Date.now();

	// Buffer: Refresh if token expires in less than 5 minutes (300000 ms)
	if (acubeTokenCache && now < tokenExpirationTime - 300000) {
		return acubeTokenCache;
	}

	console.log("A-Cube Token expired or missing. Refreshing...");

	try {
		// Switch URLs based on environment
		const isSandbox = process.env.NODE_ENV !== 'production'; // or use a specific flag
		const loginUrl = isSandbox
			? 'https://common-sandbox.api.acubeapi.com/login'
			: 'https://common.api.acubeapi.com/login';

		const response = await axios.post(loginUrl, {
			email: email,
			password: decrypt(password)
		}, {
			headers: { 'Content-Type': 'application/json' }
		});

		acubeTokenCache = response.data.token;

		// Decode token to find expiration (optional, but good practice)
		// Or just trust the docs saying it lasts 24h. We'll set a safe local expiry of 23 hours.
		tokenExpirationTime = now + (23 * 60 * 60 * 1000);

		console.log("A-Cube Login Successful. Token cached.");
		return acubeTokenCache;

	} catch (error) {
		console.error("A-Cube Login Failed:", error.response ? error.response.data : error.message);
		throw new Error("Could not authenticate with Fiscal Authority service.");
	}
}

// ==========================================
// 2. FISCALIZATION LOGIC (Updated)
// ==========================================
async function fiscalizeTransaction({ items, tip_cents, fiscal_id, type, transaction_ref }, backendUrl, email, password) {
	console.log(`Starting Fiscalization for ${type} transaction: ${transaction_ref}`);

	try {
		// A. GET VALID TOKEN
		const authToken = await getAcubeToken(email, password);
		const acubeUrl = process.env.ACUBE_API_URL || 'https://api-sandbox.acubeapi.com';

		// B. Prepare Items
		const fiscalItems = items.map(item => ({
			description: item.name || item.description || "Articolo",
			quantity: item.quantity,
			unit_price: (item.unit_price_cents || item.unit_price || 0) / 100,
			vat_rate_code: item.vat_rate_code ? String(parseFloat(item.vat_rate_code)) : "22"
		}));

		if (tip_cents > 0) {
			fiscalItems.push({
				description: "Mancia / Tip",
				quantity: 1,
				unit_price: tip_cents / 100,
				vat_rate_code: "N2"
			});
		}

		const totalAmount = fiscalItems.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0);

		const payload = {
			fiscal_id: fiscal_id,
			items: fiscalItems,
			transaction_id: transaction_ref
		};

		if (type === 'electronic') {
			payload.electronic_payment_amount = totalAmount;
		} else {
			payload.cash_payment_amount = totalAmount;
		}

		// C. Send Creation Request
		const createRes = await axios.post(`${acubeUrl}/receipts`, payload, {
			headers: {
				'Authorization': `Bearer ${authToken}`,
				'Content-Type': 'application/json'
			}
		});

		const uuid = createRes.data.uuid;
		console.log(`Fiscal Receipt Queued. UUID: ${uuid}`);

		// D. POLLING LOOP
		let fiscalDoc = null;
		let pdfBase64 = null;

		for (let i = 0; i < 15; i++) { // Increased attempts slightly
			await new Promise(resolve => setTimeout(resolve, 1000));

			try {
				// 1. Check Status (JSON)
				const checkRes = await axios.get(`${acubeUrl}/receipts/${uuid}/details`, {
					headers: {
						'Authorization': `Bearer ${authToken}`,
						'Accept': 'application/json'
					}
				});

				if (checkRes.data.status === 'ready' && checkRes.data.document_number) {
					fiscalDoc = checkRes.data;

					// 2. FETCH PDF CONTENT (The New Step)
					console.log("Receipt ready. Fetching PDF...");
					const pdfRes = await axios.get(`${acubeUrl}/receipts/${uuid}/details`, {
						headers: {
							'Authorization': `Bearer ${authToken}`,
							'Accept': 'application/pdf' // <--- REQUEST PDF
						},
						responseType: 'arraybuffer' // <--- CRITICAL: Get raw binary data
					});

					// 3. Convert Binary PDF to Base64 String
					pdfBase64 = Buffer.from(pdfRes.data, 'binary').toString('base64');

					break; // Exit loop
				}
			} catch (e) {
				console.log("Waiting for fiscalization...");
			}
		}

		const myDomain = backendUrl || `http://localhost:${process.env.PORT || 3000}`;

		return {
			success: true,
			status: fiscalDoc ? 'completed' : 'pending',
			uuid: uuid,
			document_number: fiscalDoc?.document_number || null,
			// THIS IS THE URL FOR THE QR CODE:
			public_url: `${myDomain}/public/receipt/${uuid}`
		};

	} catch (error) {
		console.error("Fiscalization Failed:", error.response?.data || error.message);
		return {
			success: false,
			error: error.response?.data?.detail || error.message
		};
	}
}

// ==========================================
// 2. Helper: Date & Customer
// ==========================================
function formatDate(date, format) {
	const pad = num => num.toString().padStart(2, '0');
	return format
		.replace('DD', pad(date.getDate()))
		.replace('MM', pad(date.getMonth() + 1))
		.replace('YYYY', date.getFullYear())
		.replace('HH', pad(date.getHours()))
		.replace('mm', pad(date.getMinutes()));
}

// ==========================================
// 3. ROUTES
// ==========================================

app.post('/connection_token', async (req, res) => {
	try {
		console.log("starting connecion token");
		const { restaurant_id } = req.body;

		if (!restaurant_id.length) return res.status(400).json({ error: "No restaurant id" });


		// Fetch the restaurant configuration from Firebase
		console.log("getting restaurant info");
		const restaurantDoc = await db.collection('restaurants').doc(restaurant_id).get();
		if (!restaurantDoc.exists) {
			return res.status(404).json({ error: "Restaurant not found in database" });
		}
		console.log("getting restaurant config");
		const config = restaurantDoc.data();

		if (!config.stripe_secret_key) {
			return res.status(500).json({ error: "Stripe key not configured for this restaurant" });
		}

		// DECRYPT the key on the fly
		console.log("getting stripe key");
		const decryptedStripeKey = decrypt(config.stripe_secret_key);

		// Initialize a LOCAL Stripe instance for this specific request
		// This ensures we use THIS restaurant's account, not the platform's.
		const tenantStripe = require('stripe')(decryptedStripeKey);

		const token = await tenantStripe.terminal.connectionTokens.create();
		res.json({ secret: token.secret });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

app.post('/create_payment_intent', async (req, res) => {
	const { amount, currency = 'eur', restaurant_id } = req.body;
	if (!amount) return res.status(400).json({ error: 'Amount required' });

	if (!restaurant_id.length) return res.status(400).json({ error: "No restaurant id" });

	// Fetch the restaurant configuration from Firebase
	const restaurantDoc = await db.collection('restaurants').doc(restaurant_id).get();

	if (!restaurantDoc.exists) {
		return res.status(404).json({ error: "Restaurant not found in database" });
	}

	const config = restaurantDoc.data();

	if (!config.stripe_secret_key) {
		return res.status(500).json({ error: "Stripe key not configured for this restaurant" });
	}

	// DECRYPT the key on the fly
	const decryptedStripeKey = decrypt(config.stripe_secret_key);

	// Initialize a LOCAL Stripe instance for this specific request
	// This ensures we use THIS restaurant's account, not the platform's.
	const tenantStripe = require('stripe')(decryptedStripeKey);

	try {
		// Generic customer for anonymous terminal payments
		const customer = await getOrCreateCustomerByEmail('anonymous_card@yourdomain.com', tenantStripe);

		const paymentIntent = await tenantStripe.paymentIntents.create({
			amount: amount,
			currency: currency,
			customer: customer.id,
			payment_method_types: ['card_present'],
			capture_method: 'manual',
		});
		res.json({ client_secret: paymentIntent.client_secret, id: paymentIntent.id });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// --- STRIPE TERMINAL FINALIZATION (Electronic Payment) ---
app.post('/capture_payment_intent', async (req, res) => {
	const {
		payment_intent_id, items = [], currency = 'eur',
		tip_amount_cents = 0, subtotal_amount_cents = 0,
		business_vat, // NEEDED FOR ACUBE
		restaurant_id, backendUrl,
		service_date = formatDate(new Date(), 'DD-MM-YYYY HH:mm')
	} = req.body;

	if (!payment_intent_id || !items.length) return res.status(400).json({ error: 'Missing data' });

	if (!restaurant_id.length) return res.status(400).json({ error: "No restaurant id" });

	if (!backendUrl.length) return res.status(400).json({ error: "No backendUrl" });

	// Fetch the restaurant configuration from Firebase
	const restaurantDoc = await db.collection('restaurants').doc(restaurant_id).get();

	if (!restaurantDoc.exists) {
		return res.status(404).json({ error: "Restaurant not found in database" });
	}

	const config = restaurantDoc.data();

	if (!config.stripe_secret_key) {
		return res.status(500).json({ error: "Stripe key not configured for this restaurant" });
	}

	if (!config.acube_email) {
		return res.status(500).json({ error: "acube_email not configured for this restaurant" });
	}

	if (!config.acube_password) {
		return res.status(500).json({ error: "acube_password not configured for this restaurant" });
	}

	// DECRYPT the key on the fly
	const decryptedStripeKey = decrypt(config.stripe_secret_key);

	// Initialize a LOCAL Stripe instance for this specific request
	// This ensures we use THIS restaurant's account, not the platform's.
	const tenantStripe = require('stripe')(decryptedStripeKey);

	try {
		// 1. Capture Payment
		const paymentIntent = await tenantStripe.paymentIntents.capture(payment_intent_id);

		// 2. Validate Amount
		const expected = subtotal_amount_cents + tip_amount_cents;
		if (paymentIntent.amount_received !== expected) {
			console.warn(`Mismatch: Captured ${paymentIntent.amount_received} vs Expected ${expected}`);
		}

		// 3. Create Stripe Invoice (For your records)
		const customer = await getOrCreateCustomerByEmail('anonymous_card@yourdomain.com', tenantStripe);

		// ... [Stripe Invoice Item Logic similar to cash_payment] ...
		// (Simplified for brevity, assuming you use the same logic as cash_payment to populate the invoice)
		// Ideally, extract the "Create Stripe Invoice" logic into a function to reuse here.
		// Create invoice items with proper period handling
		// 1. Create Stripe Invoice
		let invoice = await tenantStripe.invoices.create({
			customer: customer.id,
			collection_method: 'send_invoice',
			days_until_due: 0,
			auto_advance: false,
			automatic_tax: { enabled: true },
			description: 'POS payment',
			metadata: { payment_type: 'terminal', tip_amount_cents }
		});
		try {
			// Parse service date safely
			let serviceTimestamp;
			for (const item of items) {
				// Search for matching Stripe product
				const stripeProducts = await tenantStripe.products.search({
					query: `active:\'true\' AND name:\'${item.name}\'`,
					limit: 1
				});

				if (!stripeProducts.data[0]) {
					throw new Error(`Product "${item.name}" not found in Stripe`);
				}

				// Get the default price for this product
				const prices = await tenantStripe.prices.list({
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

				const calculation = await tenantStripe.tax.calculations.create({
					currency: currency,
					customer: customer.id,
					line_items: [
						{
							amount: item.unit_price,
							tax_code: stripeProducts.data[0].tax_code,
							reference: item.name,
							tax_behavior: "inclusive",
							quantity: item.quantity
						},
					],
					expand: ['line_items'],
				});

				item.vat_rate_code = calculation.tax_breakdown[0].tax_rate_details.percentage_decimal;

				await tenantStripe.invoiceItems.create({
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
				const tipProducts = await tenantStripe.products.search({
					query: `active:\'true\' AND name:\'${TIP_PRODUCT_NAME}\'`,
					limit: 1
				});

				if (!tipProducts.data[0]) {
					throw new Error(`Tip Product "${TIP_PRODUCT_NAME}" not found in Stripe. Please create it.`);
				}

				// 2. Create Ad-hoc Price for the specific tip amount
				// Since the tip amount is variable, we create a one-time price for it.
				const tipPrice = await tenantStripe.prices.create({
					unit_amount: tip_amount_cents, // Use the amount received from the client
					currency: currency,
					product: tipProducts.data[0].id,
					billing_scheme: 'per_unit',
					tax_behavior: 'unspecified', // Tips are usually non-taxable
				});

				// 3. Add Tip Invoice Item
				await tenantStripe.invoiceItems.create({
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

		// 4. FISCALIZATION (The Magic Part)
		const fiscalResult = await fiscalizeTransaction({
			items: items,
			tip_cents: tip_amount_cents,
			fiscal_id: business_vat,
			type: 'electronic',
			transaction_ref: payment_intent_id
		}, backendUrl, config.acube_email, config.acube_password);

		res.json({
			success: true,
			stripe_status: paymentIntent.status,
			hosted_invoice_url: fiscalResult.public_url,
			invoice_pdf: invoice.invoice_pdf,
			fiscal_receipt: fiscalResult // Contains the Document Number & PDF URL
		});

	} catch (error) {
		console.error(error);
		res.status(500).json({ error: error.message });
	}
});

// --- CASH PAYMENT (Cash Payment) ---
app.post('/cash_payment', async (req, res) => {
	const {
		items = [], tip_amount_cents = 0, currency = 'eur',
		business_vat, service_date = formatDate(new Date(), 'DD-MM-YYYY HH:mm'), restaurant_id,
		backendUrl
	} = req.body;

	if (!items.length) return res.status(400).json({ error: 'No items' });

	if (!restaurant_id.length) return res.status(400).json({error: "No restaurant id"});
	if (!backendUrl.length) return res.status(400).json({ error: "No backend url provided" });

	// Fetch the restaurant configuration from Firebase
	const restaurantDoc = await db.collection('restaurants').doc(restaurant_id).get();

	if (!restaurantDoc.exists) {
		return res.status(404).json({ error: "Restaurant not found in database" });
	}

	const config = restaurantDoc.data();

	if (!config.stripe_secret_key) {
		return res.status(500).json({ error: "Stripe key not configured for this restaurant" });
	}

	if (!config.acube_email) {
		return res.status(500).json({ error: "acube_email not configured for this restaurant" });
	}

	if (!config.acube_password) {
		return res.status(500).json({ error: "acube_password not configured for this restaurant" });
	}

	// DECRYPT the key on the fly
	console.log("trying decripting: ");
	const decryptedStripeKey = decrypt(config.stripe_secret_key);
	console.log("decripting finished: ");

	// Initialize a LOCAL Stripe instance for this specific request
	// This ensures we use THIS restaurant's account, not the platform's.
	const tenantStripe = require('stripe')(decryptedStripeKey);

	try {
		const customer = await getOrCreateCustomerByEmail('anonymous@yourdomain.com', tenantStripe);

		// 1. Create Stripe Invoice
		let invoice = await tenantStripe.invoices.create({
			customer: customer.id,
			collection_method: 'send_invoice',
			days_until_due: 0,
			auto_advance: false,
			automatic_tax: { enabled: true },
			description: 'Pagamento contanti',
			metadata: { payment_type: 'cash', tip_amount_cents }
		});

		// 2. Add Invoice Items
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
				const stripeProducts = await tenantStripe.products.search({
					query: `active:\'true\' AND name:\'${item.name}\'`,
					limit: 1
				});

				if (!stripeProducts.data[0]) {
					throw new Error(`Product "${item.name}" not found in Stripe`);
				}

				// Get the default price for this product
				const prices = await tenantStripe.prices.list({
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

				const calculation = await tenantStripe.tax.calculations.create({
					currency: currency,
					customer: customer.id,
					line_items: [
						{
							amount: item.unit_price,
							tax_code: stripeProducts.data[0].tax_code,
							reference: item.name,
							tax_behavior: "inclusive",
							quantity: item.quantity
						},
					],
					expand: ['line_items'],
				});

				item.vat_rate_code = calculation.tax_breakdown[0].tax_rate_details.percentage_decimal;
				console.log(item.vat_rate_code);


				await tenantStripe.invoiceItems.create({
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

				const tipProducts = await tenantStripe.products.search({
					query: `active:\'true\' AND name:\'${TIP_PRODUCT_NAME}\'`,
					limit: 1
				});

				if (!tipProducts.data[0]) {
					throw new Error(`Tip Product "${TIP_PRODUCT_NAME}" not found in Stripe. Please create it.`);
				}

				const tipPrice = await tenantStripe.prices.create({
					unit_amount: tip_amount_cents,
					currency: currency,
					product: tipProducts.data[0].id,
					billing_scheme: 'per_unit',
					tax_behavior: 'unspecified',
				});

				await tenantStripe.invoiceItems.create({
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


		// NOTE: Ensure your existing loop uses `items` and handles tips correctly.
		// For brevity in this solution, I am assuming the Stripe part works as per your code.

		// 3. Finalize & Pay Stripe Invoice (Out of Band)
		invoice = await tenantStripe.invoices.finalizeInvoice(invoice.id);
		if (invoice.status !== 'paid') {
			invoice = await tenantStripe.invoices.pay(invoice.id, { paid_out_of_band: true });
		}

		// 4. FISCALIZATION (The Magic Part)
		const fiscalResult = await fiscalizeTransaction({
			items: items,
			tip_cents: tip_amount_cents,
			fiscal_id: business_vat,
			type: 'cash',
			transaction_ref: invoice.id // Use Invoice ID as ref
		}, backendUrl, config.acube_email, config.acube_password);

		res.json({
			success: true,
			invoice_id: invoice.id,
			hosted_invoice_url: fiscalResult.public_url,
			invoice_pdf: invoice.invoice_pdf,
			fiscal_receipt: fiscalResult // Contains the Document Number & PDF URL
		});

	} catch (error) {
		console.error(error);
		res.status(500).json({ error: error.message });
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
			prod_id,
			restaurant_id
		} = req.body;

		if (!restaurant_id.length) return res.status(400).json({ error: "No restaurant id" });

		// Fetch the restaurant configuration from Firebase
		const restaurantDoc = await db.collection('restaurants').doc(restaurant_id).get();

		if (!restaurantDoc.exists) {
			return res.status(404).json({ error: "Restaurant not found in database" });
		}

		const config = restaurantDoc.data();

		if (!config.stripe_secret_key) {
			return res.status(500).json({ error: "Stripe key not configured for this restaurant" });
		}

		// DECRYPT the key on the fly
		const decryptedStripeKey = decrypt(config.stripe_secret_key);

		// Initialize a LOCAL Stripe instance for this specific request
		// This ensures we use THIS restaurant's account, not the platform's.
		const tenantStripe = require('stripe')(decryptedStripeKey);

		if (!create) {

			const product = await tenantStripe.products.retrieve(prod_id);

			if (!product) {
				throw new Error(`Product "${prod_id}" not found in Stripe`);
			}

			let price;

			const priceOld = await tenantStripe.prices.retrieve(product.default_price);

			if (priceOld.unit_amount === unit_amount) {
				price = priceOld;
			} else {
				price = await tenantStripe.prices.create({
					currency,
					unit_amount: unit_amount,
					product: product.id,
					tax_behavior: "inclusive",

				});
			}

			const productUpdate = await tenantStripe.products.update(
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
			const product = await tenantStripe.products.create({
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

// ==========================================
// 4. VOID RECEIPT ROUTE
// ==========================================
app.post('/void_receipt', async (req, res) => {
	const { receipt_uuid, restaurant_id } = req.body;

	if (!receipt_uuid) return res.status(400).json({ error: "Missing receipt_uuid" });
	if (!restaurant_id) return res.status(400).json({ error: "Missing restaurant_id" });

	try {
		// 1. Fetch Restaurant Config (for A-Cube credentials)
		const restaurantDoc = await db.collection('restaurants').doc(restaurant_id).get();
		if (!restaurantDoc.exists) {
			return res.status(404).json({ error: "Restaurant not found" });
		}
		const config = restaurantDoc.data();

		if (!config.acube_email || !config.acube_password) {
			return res.status(500).json({ error: "A-Cube credentials missing for this restaurant" });
		}

		// 2. Get A-Cube Token
		const authToken = await getAcubeToken(config.acube_email, config.acube_password);
		const acubeUrl = process.env.ACUBE_API_URL || 'https://api-sandbox.acubeapi.com';

		// 3. Send VOID Request (DELETE method)
		console.log(`Voiding receipt: ${receipt_uuid}`);

		const voidRes = await axios.delete(`${acubeUrl}/receipts/${receipt_uuid}`, {
			headers: {
				'Authorization': `Bearer ${authToken}`,
				'Accept': 'application/json'
			}
		});

		// 4. Handle Success
		// The API returns the NEW void document. We return its UUID and status.
		const newVoidDocument = voidRes.data;

		console.log(`Receipt voided successfully. New Void UUID: ${newVoidDocument.uuid}`);

		res.json({
			success: true,
			original_uuid: receipt_uuid,
			void_uuid: newVoidDocument.uuid,
			status: newVoidDocument.status,
			message: "Receipt voided successfully"
		});

	} catch (error) {
		console.error("Void Failed:", error.response?.data || error.message);

		// Handle specific A-Cube errors (e.g., if receipt is too old to void)
		const errorMessage = error.response?.data?.detail || error.message;

		res.status(500).json({
			success: false,
			error: "Failed to void receipt",
			details: errorMessage
		});
	}
});

app.get('/public/receipt/:uuid', async (req, res) => {
	const { uuid } = req.params;

	if (!uuid) return res.status(400).send("Missing Receipt UUID");

	try {
		console.log(`Proxying receipt request for: ${uuid}`);

		// 1. Get a fresh token (using your existing helper)
		const authToken = await getAcubeToken();
		const acubeUrl = process.env.ACUBE_API_URL || 'https://api-sandbox.acubeapi.com';

		// 2. Request the PDF from A-Cube
		// Note: We use 'responseType: stream' to pipe it directly to the user
		const response = await axios.get(`${acubeUrl}/receipts/${uuid}/details`, {
			headers: {
				'Authorization': `Bearer ${authToken}`,
				'Accept': 'application/pdf' // Request PDF format
			},
			responseType: 'stream'
		});

		// 3. Set headers so the customer's phone knows it's a PDF
		res.setHeader('Content-Type', 'application/pdf');
		res.setHeader('Content-Disposition', `inline; filename="receipt_${uuid}.pdf"`);

		// 4. Pipe the A-Cube response directly to the Customer
		response.data.pipe(res);

	} catch (error) {
		console.error("Proxy Error:", error.message);
		res.status(500).send("Could not retrieve receipt. It may not be ready yet.");
	}
});

async function getOrCreateCustomerByEmail(anonymousCustomerEmail, tenantStripe) {
	// Create or retrieve customer
	let customer;
	try {
		const customers = await tenantStripe.customers.list({ email: anonymousCustomerEmail, limit: 1 });
		customer = customers.data[0] || await tenantStripe.customers.create({
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
	console.log(`Server running on port ${PORT}`);
});
