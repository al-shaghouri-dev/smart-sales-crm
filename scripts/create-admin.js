#!/usr/bin/env node
/*
 * Creates (or resets) a manager account for the legacy JSON workspace.
 * Usage: node scripts/create-admin.js <username> "<Full Name>"
 * The password is read from ADMIN_PASSWORD or prompted for interactively; it is never printed.
 */
const path = require('path');
const readline = require('readline');
const { createApp, ROLES } = require('../server');

async function promptHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); };
  return new Promise(resolve => rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); }));
}

(async () => {
  const [username, ...nameParts] = process.argv.slice(2);
  if (!username) {
    console.error('Usage: node scripts/create-admin.js <username> "<Full Name>"');
    process.exit(1);
  }
  const password = process.env.ADMIN_PASSWORD || await promptHidden('Password (min 8 chars): ');
  if (String(password).length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
  const app = createApp({ dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data') });
  const { readData, writeData, hashPassword } = app.locals;
  const employees = readData('employees');
  const key = username.trim().toLowerCase();
  let user = employees.find(e => String(e.username).toLowerCase() === key);
  if (user) {
    user.passwordHash = hashPassword(password);
    delete user.password;
    user.role = ROLES.MANAGER;
    user.status = 'نشط';
    user.updatedAt = new Date().toISOString();
    console.log(`Updated manager account "${key}".`);
  } else {
    user = { id: `${Date.now()}`, name: nameParts.join(' ') || key, username: key, role: ROLES.MANAGER, status: 'نشط', shift: '', createdAt: new Date().toISOString(), passwordHash: hashPassword(password) };
    employees.unshift(user);
    console.log(`Created manager account "${key}".`);
  }
  writeData('employees', employees);
})();
