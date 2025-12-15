const crypto = require('crypto');
const users = [];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [salt, stored] = passwordHash.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(hash, 'hex'));
}

function seedAdmin(email, password) {
  if (users.find((u) => u.email === email)) return;
  users.push({ id: users.length + 1, email, password_hash: hashPassword(password), role: 'Admin', status: 'active' });
}

function authenticate(email, password) {
  const user = users.find((u) => u.email === email && u.status === 'active');
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return { id: user.id, email: user.email, role: user.role };
}

module.exports = { users, hashPassword, verifyPassword, seedAdmin, authenticate };
