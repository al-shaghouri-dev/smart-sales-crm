const readline = require('readline');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]] = m[2] !== undefined ? m[2] : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return args;
}

/** Reads a password without echoing it. Uses PASSWORD env var when set (non-interactive use). */
async function readPassword(prompt) {
  if (process.env.PASSWORD) return process.env.PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = s => { if (s.includes(prompt)) rl.output.write(s); };
  return new Promise(resolve => rl.question(prompt, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); }));
}

module.exports = { parseArgs, readPassword };
