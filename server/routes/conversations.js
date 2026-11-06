const express = require('express');
const multer = require('multer');
const v = require('../validate');
const { requireAuth, requireCompany, requirePermission } = require('../middleware/session');
const { AppError, badRequest, conflict, forbidden, notFound } = require('../errors');
const { audit } = require('../services/audit');
const { providerAllowed, planFor } = require('../services/channels');
const { inspectUpload } = require('../media/storage');
const { visibilityOf, requireInboxAccess, scopeConversations } = require('../messaging/access');
const { messageOut, conversationOut } = require('../messaging/serialize');

const PAGE = 30;
const MAX_TEXT = 4096;

/** Opaque cursor for "last activity desc, id desc" pagination. */
const encodeCursor = (at, id) => Buffer.from(JSON.stringify([at, id])).toString('base64url');
function decodeCursor(cursor) {
  try {
    const [at, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(new Date(at).getTime())) throw new Error('bad');
    return { at: new Date(at), id };
  } catch { throw badRequest('validation.invalid', 'Invalid cursor', { field: 'cursor' }); }
}
const escapeLike = s => s.replace(/[\\%_]/g, m => `\\${m}`);

/**
 * Unified inbox API. Every query runs in the member's company context (RLS) AND is narrowed to
 * what the member may see (view_all / view_assigned). Hidden conversations answer 404.
 */
module.exports = function conversationRoutes({ db, config, providers, messaging, media }) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: messaging.maxMediaBytes, files: 1, fields: 10 } });
  router.use(requireAuth, requireCompany, requireInboxAccess);

  const tenant = (req, fn) => db.withContext({ companyId: req.company.id, userId: req.user.id }, fn);
  const scopeOf = req => ({ visibility: visibilityOf(req.permissions), membershipId: req.membership?.id });
  const windowHoursFor = provider => providers.get(provider)?.capabilities?.replyWindowHours || null;

  const baseQuery = trx => trx('conversations as c')
    .join('channels as ch', 'ch.id', 'c.channel_id')
    .join('contacts as ct', 'ct.id', 'c.contact_id')
    .join('contact_identities as ci', 'ci.id', 'c.identity_id')
    .leftJoin('company_memberships as am', 'am.id', 'c.assigned_membership_id')
    .leftJoin('users as au', 'au.id', 'am.user_id')
    .select('c.*', 'ch.provider as channel_provider', 'ch.display_name as channel_name', 'ch.status as channel_status',
      'ct.display_name as contact_name', 'ct.phone as contact_phone', 'ct.email as contact_email',
      'ci.profile as identity_profile', 'ci.external_user_id as identity_external_id', 'au.name as assignee_name');

  const out = c => conversationOut(c, { windowHours: windowHoursFor(c.channel_provider) });

  async function loadVisible(trx, req, id, { lock = false } = {}) {
    const q = scopeConversations(trx('conversations as c').where('c.id', v.uuid(id)), scopeOf(req));
    if (lock) q.forUpdate();
    const row = await q.first('c.*');
    if (!row) throw notFound('conversations.not_found', 'Conversation not found');
    return row;
  }
  const loadFull = (trx, id) => baseQuery(trx).where('c.id', id).first();

  async function notify(trx, req, conversation, extraMembershipIds = []) {
    const userIds = await messaging.userIdsFor(trx, [conversation.assigned_membership_id, ...extraMembershipIds]);
    return () => messaging.emitConversation(req.company.id, conversation.id, userIds);
  }

  // ------------------------------------------------------------------ list
  router.get('/', async (req, res) => {
    const q = req.query;
    const status = v.oneOf(q.status || undefined, ['open', 'pending', 'closed', 'all'], { field: 'status' }) || 'open';
    const search = v.str(q.search, { field: 'search', max: 100 });
    const limit = Math.min(Number.parseInt(q.limit, 10) || PAGE, 100);
    const result = await tenant(req, async trx => {
      const query = scopeConversations(baseQuery(trx), scopeOf(req));
      if (status !== 'all') query.where('c.status', status);
      if (q.channelId) query.where('c.channel_id', v.uuid(q.channelId, { field: 'channelId' }));
      if (q.priority) query.where('c.priority', v.oneOf(q.priority, ['low', 'normal', 'high', 'urgent'], { field: 'priority' }));
      if (q.unread === 'true') query.where('c.unread_count', '>', 0);
      if (q.assigned === 'me') query.where('c.assigned_membership_id', req.membership.id);
      else if (q.assigned === 'unassigned') query.whereNull('c.assigned_membership_id');
      else if (q.assigned) query.where('c.assigned_membership_id', v.uuid(q.assigned, { field: 'assigned' }));
      if (search) {
        const like = `%${escapeLike(search)}%`;
        query.where(w => w.whereRaw("ct.display_name ILIKE ? ESCAPE '\\'", [like]).orWhereRaw("ct.phone ILIKE ? ESCAPE '\\'", [like])
          .orWhereRaw("c.last_message_preview ILIKE ? ESCAPE '\\'", [like]).orWhereRaw("ci.profile->>'username' ILIKE ? ESCAPE '\\'", [like]));
      }
      const activity = trx.raw('COALESCE(c.last_message_at, c.created_at)');
      if (q.cursor) {
        const cur = decodeCursor(q.cursor);
        query.whereRaw('(COALESCE(c.last_message_at, c.created_at), c.id) < (?, ?)', [cur.at, cur.id]);
      }
      const rows = await query.select(trx.raw('COALESCE(c.last_message_at, c.created_at) AS activity_at')).orderBy([{ column: activity, order: 'desc' }, { column: 'c.id', order: 'desc' }]).limit(limit + 1);
      const counts = await scopeConversations(trx('conversations as c'), scopeOf(req))
        .select(trx.raw("count(*) FILTER (WHERE c.status = 'open') AS open, count(*) FILTER (WHERE c.status = 'pending') AS pending, count(*) FILTER (WHERE c.unread_count > 0 AND c.status <> 'closed') AS unread"))
        .first();
      return { rows, counts };
    });
    const more = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    res.json({
      conversations: rows.map(out),
      nextCursor: more && last ? encodeCursor(last.activity_at, last.id) : null,
      counts: { open: Number(result.counts.open), pending: Number(result.counts.pending), unread: Number(result.counts.unread) }
    });
  });

  /** Members a conversation can be assigned to (active, with inbox access). */
  router.get('/assignees', requirePermission('conversations.assign'), async (req, res) => {
    const rows = await tenant(req, trx => trx('company_memberships as m').join('users as u', 'u.id', 'm.user_id')
      .where({ 'm.company_id': req.company.id, 'm.status': 'active' })
      .whereExists(trx('role_permissions as rp').whereRaw('rp.role_id = m.role_id').whereIn('rp.permission_key', ['conversations.view_all', 'conversations.view_assigned']))
      .orderBy('u.name').select('m.id', 'u.name', 'u.email'));
    res.json({ assignees: rows.map(r => ({ membershipId: r.id, name: r.name, email: r.email })) });
  });

  /** Company quick replies for the composer (managed in company settings). */
  router.get('/quick-replies', async (req, res) => {
    const row = await tenant(req, trx => trx('company_settings').where({ company_id: req.company.id }).first('quick_replies'));
    res.json({ quickReplies: Array.isArray(row?.quick_replies) ? row.quick_replies : [] });
  });

  // ------------------------------------------------------------------ one conversation
  router.get('/:id', async (req, res) => {
    const row = await tenant(req, async trx => { const c = await loadVisible(trx, req, req.params.id); return loadFull(trx, c.id); });
    res.json({ conversation: out(row) });
  });

  router.get('/:id/messages', async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const rows = await tenant(req, async trx => {
      const c = await loadVisible(trx, req, req.params.id);
      const q = trx('messages as m').leftJoin('company_memberships as sm', 'sm.id', 'm.sender_membership_id').leftJoin('users as su', 'su.id', 'sm.user_id')
        .where('m.conversation_id', c.id).select('m.*', 'su.name as sender_name');
      if (req.query.before) {
        const ref = await trx('messages').where({ id: v.uuid(req.query.before, { field: 'before' }), conversation_id: c.id }).first('created_at', 'id');
        if (!ref) throw badRequest('validation.invalid', 'Invalid cursor', { field: 'before' });
        q.whereRaw('(m.created_at, m.id) < (?, ?)', [ref.created_at, ref.id]);
      }
      return q.orderBy([{ column: 'm.created_at', order: 'desc' }, { column: 'm.id', order: 'desc' }]).limit(limit + 1);
    });
    const more = rows.length > limit;
    res.json({ messages: rows.slice(0, limit).reverse().map(messageOut), hasMore: more });
  });

  // ------------------------------------------------------------------ reply
  router.post('/:id/messages', requirePermission('conversations.reply'), upload.single('file'), async (req, res) => {
    const b = req.body || {};
    const text = b.text === undefined || b.text === null ? '' : String(b.text).trim();
    if (text.length > MAX_TEXT) throw badRequest('validation.length', 'Message is too long', { field: 'text', max: MAX_TEXT });
    const clientMessageId = b.clientMessageId ? v.str(b.clientMessageId, { field: 'clientMessageId', max: 80 }) : null;
    if (clientMessageId && !/^[A-Za-z0-9_-]{8,80}$/.test(clientMessageId)) throw badRequest('validation.invalid', 'Invalid clientMessageId', { field: 'clientMessageId' });
    const file = req.file ? inspectUpload(req.file, { maxBytes: messaging.maxMediaBytes }) : null;
    if (!text && !file) throw badRequest('messages.empty', 'Write a message or attach a file');

    // 1) Policy checks (visibility, channel state, plan, provider window, kill switch).
    const pre = await tenant(req, async trx => {
      const c = await loadVisible(trx, req, req.params.id);
      const channel = await trx('channels').where({ id: c.channel_id }).first();
      if (clientMessageId) {
        const existing = await trx('messages').where({ conversation_id: c.id, client_message_id: clientMessageId }).first();
        if (existing) return { existing };
      }
      const company = await trx('companies').where({ id: req.company.id }).first('outbound_paused', 'outbound_daily_limit');
      if (company?.outbound_paused) throw conflict('messages.outbound_paused', 'Sending is paused for this workspace');
      if (company?.outbound_daily_limit) {
        const sent = await trx('messages').where({ company_id: req.company.id, direction: 'out' })
          .where('created_at', '>=', trx.raw("date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")).count('* as n').first();
        if (Number(sent.n) >= company.outbound_daily_limit) throw new AppError(429, 'messages.daily_limit', 'The daily sending limit for this workspace has been reached');
      }
      if (channel.status !== 'active') throw conflict('messages.channel_unavailable', 'This channel is not connected');
      const adapter = providers.get(channel.provider);
      if (!adapter || adapter.capabilities?.outbound === false) throw conflict('messages.channel_unavailable', 'This channel is not available');
      if (!providerAllowed(await planFor(trx, req.company.id), channel.provider)) throw forbidden('channels.provider_not_allowed', 'Your plan does not include this channel type');
      if (file && !adapter.capabilities?.media) throw badRequest('messages.media_unsupported', 'This channel does not support attachments');
      const hours = adapter.capabilities?.replyWindowHours;
      if (hours && (!c.last_inbound_at || new Date(c.last_inbound_at).getTime() + hours * 3600 * 1000 < Date.now())) {
        throw conflict('messages.window_closed', 'The reply window for this conversation has closed');
      }
      return { conversation: c, channel };
    });
    if (pre.existing) return res.status(200).json({ message: messageOut(pre.existing), duplicate: true });

    // 2) Store the attachment (outside the transaction: object storage may be remote).
    let attachments = [];
    if (file) {
      const stored = await media.put({ companyId: req.company.id, buffer: req.file.buffer, ext: file.ext, contentType: file.mime });
      attachments = [{ id: require('crypto').randomUUID(), key: stored.key, name: file.name, contentType: file.mime, size: stored.size, kind: file.kind, inline: file.inline }];
    }
    const type = file ? (file.kind === 'image' ? 'image' : file.kind === 'audio' ? 'audio' : file.kind === 'video' ? 'video' : 'file') : 'text';

    // 3) Insert the queued message (idempotent on clientMessageId) and update the conversation.
    const created = await tenant(req, async trx => {
      const ins = await trx.raw(`
        INSERT INTO messages (company_id, conversation_id, channel_id, direction, sender_type, sender_membership_id, type, body, attachments, client_message_id, status)
        VALUES (?, ?, ?, 'out', 'member', ?, ?, ?, ?::jsonb, ?, 'queued')
        ON CONFLICT (conversation_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING
        RETURNING *`,
      [req.company.id, pre.conversation.id, pre.channel.id, req.membership.id, type, text || null, JSON.stringify(attachments), clientMessageId]);
      const message = ins.rows[0];
      if (!message) return { existing: await trx('messages').where({ conversation_id: pre.conversation.id, client_message_id: clientMessageId }).first() };
      const [conv] = await trx('conversations').where({ id: pre.conversation.id }).update({
        last_message_preview: messaging.previewOf(text, attachments), last_message_at: message.created_at, unread_count: 0,
        status: trx.raw("CASE WHEN status = 'closed' THEN 'open' ELSE status END"), updated_at: new Date()
      }).returning('*');
      return { message: { ...message, sender_name: req.user.name }, emit: await notify(trx, req, conv) };
    });
    if (created.existing) {
      if (attachments[0]) await media.remove(attachments[0].key).catch(() => {});
      return res.status(200).json({ message: messageOut(created.existing), duplicate: true });
    }
    await messaging.enqueue(created.message.id, req.company.id);
    messaging.emitMessage(req.company.id, pre.conversation.id, 'message:new', created.message);
    created.emit();
    res.status(201).json({ message: messageOut(created.message) });
  });

  /** Retry a failed outbound message (same row; never duplicates a sent one). */
  router.post('/:id/messages/:messageId/retry', requirePermission('conversations.reply'), async (req, res) => {
    const row = await tenant(req, async trx => {
      const c = await loadVisible(trx, req, req.params.id);
      const [m] = await trx('messages').where({ id: v.uuid(req.params.messageId), conversation_id: c.id, direction: 'out', status: 'failed' })
        .update({ status: 'queued', attempts: 0, error_code: null, updated_at: new Date() }).returning('*');
      if (!m) throw notFound('messages.not_retryable', 'Only failed messages can be retried');
      return m;
    });
    await messaging.enqueue(row.id, req.company.id);
    messaging.emitMessage(req.company.id, row.conversation_id, 'message:updated', row);
    res.json({ message: messageOut(row) });
  });

  // ------------------------------------------------------------------ state changes
  router.post('/:id/read', async (req, res) => {
    const emit = await tenant(req, async trx => {
      const c = await loadVisible(trx, req, req.params.id);
      if (c.unread_count === 0) return null;
      const [conv] = await trx('conversations').where({ id: c.id }).update({ unread_count: 0 }).returning('*');
      return notify(trx, req, conv);
    });
    if (emit) emit();
    res.json({ ok: true });
  });

  router.patch('/:id', requirePermission('conversations.reply', 'conversations.assign'), async (req, res) => {
    const patch = v.compact({
      status: v.oneOf(req.body?.status, ['open', 'pending', 'closed'], { field: 'status' }) ?? undefined,
      priority: v.oneOf(req.body?.priority, ['low', 'normal', 'high', 'urgent'], { field: 'priority' }) ?? undefined
    });
    if (!Object.keys(patch).length) throw badRequest('validation.required', 'Nothing to update');
    const { row, emit } = await tenant(req, async trx => {
      const c = await loadVisible(trx, req, req.params.id, { lock: true });
      const [conv] = await trx('conversations').where({ id: c.id }).update({ ...patch, updated_at: new Date() }).returning('*');
      return { row: await loadFull(trx, conv.id), emit: await notify(trx, req, conv) };
    });
    emit();
    res.json({ conversation: out(row) });
  });

  router.post('/:id/assign', requirePermission('conversations.assign'), async (req, res) => {
    const target = req.body?.membershipId === null || req.body?.membershipId === '' ? null : v.uuid(req.body?.membershipId, { field: 'membershipId' });
    const reason = v.str(req.body?.reason, { field: 'reason', max: 200 }) || null;
    const result = await tenant(req, async trx => {
      const c = await loadVisible(trx, req, req.params.id, { lock: true });
      if (target) {
        const ok = await trx('company_memberships as m').where({ 'm.id': target, 'm.company_id': req.company.id, 'm.status': 'active' })
          .whereExists(trx('role_permissions as rp').whereRaw('rp.role_id = m.role_id').whereIn('rp.permission_key', ['conversations.view_all', 'conversations.view_assigned']))
          .first('m.id');
        if (!ok) throw badRequest('conversations.invalid_assignee', 'This member cannot be assigned conversations', { field: 'membershipId' });
      }
      if ((c.assigned_membership_id || null) === target) return { row: await loadFull(trx, c.id), emit: () => {}, changed: false };
      const [conv] = await trx('conversations').where({ id: c.id }).update({ assigned_membership_id: target, updated_at: new Date() }).returning('*');
      await trx('conversation_assignments').insert({
        company_id: req.company.id, conversation_id: c.id, from_membership_id: c.assigned_membership_id, to_membership_id: target,
        assigned_by_user_id: req.user.id, reason
      });
      await audit(trx, req, { action: 'conversation.assigned', companyId: req.company.id, entityType: 'conversation', entityId: c.id,
        before: { assignedMembershipId: c.assigned_membership_id }, after: { assignedMembershipId: target } });
      return { row: await loadFull(trx, c.id), emit: await notify(trx, req, conv, [c.assigned_membership_id]), changed: true };
    });
    result.emit();
    // Members who lost access stop receiving this conversation's live messages.
    if (result.changed) await req.app.locals.realtime?.refreshResource(req.company.id, 'conversation', result.row.id).catch(() => {});
    res.json({ conversation: out(result.row) });
  });

  router.get('/:id/assignments', async (req, res) => {
    const rows = await tenant(req, async trx => {
      const c = await loadVisible(trx, req, req.params.id);
      return trx('conversation_assignments as a')
        .leftJoin('company_memberships as tm', 'tm.id', 'a.to_membership_id').leftJoin('users as tu', 'tu.id', 'tm.user_id')
        .leftJoin('users as bu', 'bu.id', 'a.assigned_by_user_id')
        .where('a.conversation_id', c.id).orderBy('a.created_at', 'desc').limit(50)
        .select('a.id', 'a.created_at', 'a.reason', 'a.to_membership_id', 'tu.name as to_name', 'bu.name as by_name');
    });
    res.json({ assignments: rows.map(r => ({ id: Number(r.id), at: r.created_at, reason: r.reason, toMembershipId: r.to_membership_id, toName: r.to_name, byName: r.by_name })) });
  });

  // ------------------------------------------------------------------ attachments
  router.get('/:id/attachments/:attachmentId', async (req, res) => {
    const attachmentId = v.uuid(req.params.attachmentId, { field: 'attachmentId' });
    const attachment = await tenant(req, async trx => {
      const c = await loadVisible(trx, req, req.params.id);
      const m = await trx('messages').where({ conversation_id: c.id }).whereRaw('attachments @> ?::jsonb', [JSON.stringify([{ id: attachmentId }])]).first('attachments');
      return m && m.attachments.find(a => a.id === attachmentId);
    });
    if (!attachment || !attachment.key) throw notFound();
    const bytes = await media.get(attachment.key);
    const inline = Boolean(attachment.inline) && /^image\/(png|jpeg|gif|webp)$/.test(attachment.contentType);
    res.set({
      'Content-Type': inline ? attachment.contentType : 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name || 'file')}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=300'
    });
    res.send(bytes);
  });

  return router;
};
