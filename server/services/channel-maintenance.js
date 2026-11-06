const { readCredentials, storeCredentials, flagChannel } = require('./channels');

/**
 * Hourly channel maintenance (pg-boss "channel.maintenance"):
 *  - refresh tokens that expire within 10 days when the provider supports it (Instagram);
 *  - flag channels whose token already expired as needs_reconnect;
 *  - notify the company's channel managers (in-app, de-duplicated per day) about channels that
 *    need reconnecting or whose token is about to expire.
 * Idempotent; each channel is handled in its own company context.
 */
const DAY = 86400 * 1000;

async function runChannelMaintenance({ db, config, providers, logger = console, now = () => Date.now() }) {
  const list = (await db.knex.raw('SELECT * FROM app_channels_for_maintenance()')).rows;
  const result = { checked: list.length, refreshed: 0, flagged: 0, notified: 0 };
  for (const item of list) {
    try {
      await db.withContext({ companyId: item.company_id, system: true }, async trx => {
        const channel = await trx('channels').where({ id: item.channel_id }).first();
        if (!channel || channel.status === 'disconnected') return;
        const adapter = providers.get(channel.provider);
        let status = channel.status;
        let reason = channel.last_error;
        const expiresAt = item.expires_at ? new Date(item.expires_at).getTime() : null;

        if (status === 'active' && expiresAt && adapter?.refreshCredentials && expiresAt - now() < 10 * DAY) {
          try {
            const creds = await readCredentials(trx, config.keyRing, channel);
            const fresh = await adapter.refreshCredentials({ channel, credentials: creds, config });
            await storeCredentials(trx, config.keyRing, channel, fresh.credentials, { expiresAt: fresh.expiresAt });
            result.refreshed++;
            return;
          } catch (error) {
            logger.error(`[channels] token refresh failed for ${channel.id}: ${error.code || 'error'}`);
            if (expiresAt < now() || /token|permission/.test(error.code || '')) {
              status = 'needs_reconnect'; reason = error.code || 'provider.token_expired';
              await flagChannel(trx, channel, { status, error: reason });
              result.flagged++;
            }
          }
        } else if (status === 'active' && expiresAt && expiresAt < now()) {
          status = 'needs_reconnect'; reason = 'provider.token_expired';
          await flagChannel(trx, channel, { status, error: reason });
          result.flagged++;
        }

        const attention = status !== 'active' ? 'channel_needs_attention' : (expiresAt && expiresAt - now() < 10 * DAY ? 'channel_token_expiring' : null);
        if (!attention) return;
        const recipients = await trx('company_memberships as m').join('users as u', 'u.id', 'm.user_id')
          .join('role_permissions as rp', 'rp.role_id', 'm.role_id')
          .where({ 'm.company_id': channel.company_id, 'm.status': 'active', 'u.status': 'active', 'rp.permission_key': 'channels.manage' })
          .distinct('u.id');
        const day = new Date(now()).toISOString().slice(0, 10);
        for (const r of recipients) {
          // Plain INSERT inside a savepoint: ON CONFLICT / RETURNING would require reading other
          // users' notifications, which RLS (correctly) forbids. A duplicate simply rolls back.
          try {
            await trx.transaction(sp => sp('notifications').insert({
              company_id: channel.company_id, user_id: r.id, type: attention, dedupe_key: `${attention}:${channel.id}:${day}`,
              data: JSON.stringify({ channelId: channel.id, channelName: channel.display_name, provider: channel.provider, reason, expiresAt: item.expires_at })
            }));
            result.notified++;
          } catch (error) {
            if (error.code !== '23505') throw error;
          }
        }
      });
    } catch (error) {
      logger.error(`[channels] maintenance error for ${item.channel_id}: ${error.code || error.message}`);
    }
  }
  return result;
}

module.exports = { runChannelMaintenance };
