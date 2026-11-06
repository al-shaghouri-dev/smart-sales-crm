const { createFakeProvider } = require('./providers/fake');
const { createTelegramProvider } = require('./providers/telegram');
const { createMessengerProvider } = require('./providers/messenger');
const { createInstagramProvider } = require('./providers/instagram');
const { createWhatsAppProvider } = require('./providers/whatsapp');

/** Providers planned for later phases. Enabling one before it exists fails loudly at start-up. */
const PLANNED = {};
const FACTORIES = { messenger: createMessengerProvider, instagram: createInstagramProvider, whatsapp: createWhatsAppProvider };

/**
 * Build the enabled provider adapters from configuration (CHANNEL_PROVIDERS).
 * `extra` lets tests inject adapters.
 */
function createProviderRegistry(config, extra = []) {
  const adapters = new Map();
  for (const name of config.channelProviders || []) {
    if (name === 'fake') {
      if (config.isProd) throw new Error('The fake channel provider cannot be enabled in production');
      adapters.set('fake', createFakeProvider({ secret: config.fakeProviderSecret }));
    } else if (name === 'telegram') {
      adapters.set('telegram', createTelegramProvider({ config }));
    } else if (FACTORIES[name]) {
      adapters.set(name, FACTORIES[name]({ config }));
    } else if (PLANNED[name]) {
      throw new Error(`Channel provider "${name}" is not implemented yet (planned for Phase ${PLANNED[name]})`);
    } else {
      throw new Error(`Unknown channel provider "${name}"`);
    }
  }
  for (const adapter of extra) adapters.set(adapter.id, adapter);
  return {
    get: id => adapters.get(id) || null,
    has: id => adapters.has(id),
    list: () => [...adapters.values()].map(a => ({ id: a.id, displayName: a.displayName, capabilities: a.capabilities }))
  };
}

module.exports = { createProviderRegistry, PLANNED };
