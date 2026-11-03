const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;
const MIN_LENGTH = 8;
const MAX_LENGTH = 200;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(String(password), salt, KEYLEN);
  return `scrypt:${salt}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !String(stored).startsWith('scrypt:')) return false;
  const [, salt, expected] = String(stored).split(':');
  if (!salt || !expected) return false;
  const actual = await scrypt(String(password), salt, KEYLEN);
  const exp = Buffer.from(expected, 'hex');
  return exp.length === actual.length && crypto.timingSafeEqual(actual, exp);
}

// Used when the user does not exist so response timing does not reveal valid emails.
let dummy;
async function dummyVerify(password) {
  dummy = dummy || await hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(password, dummy);
  return false;
}

function validatePassword(password) {
  const p = String(password || '');
  return p.length >= MIN_LENGTH && p.length <= MAX_LENGTH;
}

module.exports = { hashPassword, verifyPassword, dummyVerify, validatePassword, MIN_LENGTH };
