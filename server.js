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
		console.log('ConnectionToken created and secret sent.\n' + connectionToken.secret);
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

// --- Example endpoint for finalizing an order (as discussed previously) ---
// This would interact with your Firestore database
// Make sure you have Firebase Admin SDK initialized if using this
// const admin = require('firebase-admin');
// const serviceAccount = require('./path/to/your/serviceAccountKey.json'); // Adjust path
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
//   databaseURL: 'https://your-project-id.firebaseio.com'
// });
// const db = admin.firestore();

app.post('/finalize_order', async (req, res) => {
	const { restaurantId, tableId } = req.body;
	console.log(`Received request to finalize order for restaurant: ${restaurantId}, table: ${tableId}`);

	if (!restaurantId || !tableId) {
		return res.status(400).json({ error: 'Missing restaurantId or tableId' });
	}

	try {
		// Placeholder for your Firestore logic
		// In a real app, you'd use Firebase Admin SDK here to:
		// 1. Get the table's current order subcollection
		// 2. Delete all documents in that subcollection
		// 3. Update the table document's status to 'Available' and totalPrice to 0.0
		console.log(`Simulating order finalization for Table ${tableId} in Restaurant ${restaurantId}`);
		// Example:
		// const tableRef = db.collection('restaurants').doc(restaurantId).collection('tables').doc(tableId);
		// const currentOrderRef = tableRef.collection('currentOrder');
		// const batch = db.batch();
		// const orderItemsSnapshot = await currentOrderRef.get();
		// orderItemsSnapshot.docs.forEach(doc => { batch.delete(doc.ref); });
		// batch.update(tableRef, { status: 'Available', totalPrice: 0.0 });
		// await batch.commit();

		res.json({ success: true, message: 'Order finalized and table reset (simulated).' });
	} catch (error) {
		console.error('Error finalizing order:', error);
		res.status(500).json({ error: 'Failed to finalize order: ' + error.message });
	}
});


// Start the server
app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
	console.log('Remember to set your STRIPE_SECRET_KEY in a .env file!');
});
