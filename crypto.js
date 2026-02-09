// crypto.js
require('dotenv').config();
const crypto = require('crypto');
const { Buffer } = require('buffer');
const algorithm = 'aes-256-cbc'; // Standard secure algorithm
const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes
const ivLength = 16;

function encrypt(text) {
	let iv = crypto.randomBytes(ivLength);
	let cipher = crypto.createCipheriv(algorithm, Buffer.from(key), iv);
	let encrypted = cipher.update(text);
	encrypted = Buffer.concat([encrypted, cipher.final()]);
	// Return IV + Encrypted Text (separated by :)
	return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
	let textParts = text.split(':');
	let iv = Buffer.from(textParts.shift(), 'hex');
	let encryptedText = Buffer.from(textParts.join(':'), 'hex');
	let decipher = crypto.createDecipheriv(algorithm, Buffer.from(key), iv);
	let decrypted = decipher.update(encryptedText);
	decrypted = Buffer.concat([decrypted, decipher.final()]);
	return decrypted.toString();
}

module.exports = { encrypt, decrypt };
