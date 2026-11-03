const { loadConfig } = require('./config');
const { createRuntime } = require('./runtime');

// `--role=web|worker|all` (works the same on Windows PowerShell, macOS and Linux) overrides PROCESS_ROLE.
const roleArg = process.argv.find(arg => arg.startsWith('--role='));
const config = loadConfig(roleArg ? { ...process.env, PROCESS_ROLE: roleArg.slice('--role='.length) } : process.env);
const runtime = createRuntime(config);

runtime.start().then(({ port }) => {
  const role = config.processRole;
  if (port) console.log(`Smart Sales CRM (${role}) listening on http://localhost:${port}`);
  else console.log(`Smart Sales CRM (${role}) started without HTTP listener`);
}).catch(error => {
  console.error('Start-up failed:', error.code || error.message);
  process.exit(1);
});

// Graceful shutdown: SIGTERM (platforms, Docker) and SIGINT (Ctrl+C). A second signal or the
// timeout forces exit so a stuck dependency can never hang a deploy.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`${signal} received — shutting down gracefully`);
    const force = setTimeout(() => { console.error('Shutdown timed out; forcing exit'); process.exit(1); }, config.shutdownTimeoutMs + 5000);
    force.unref();
    runtime.stop().then(() => process.exit(0)).catch(error => { console.error('Shutdown error:', error.code || error.message); process.exit(1); });
  });
}
