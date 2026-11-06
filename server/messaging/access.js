const { forbidden } = require('../errors');

/**
 * Conversation visibility (server-side; the UI only mirrors it):
 *   conversations.view_all       every conversation of the company
 *   conversations.view_assigned  only conversations assigned to the member
 *   neither                      no access to the inbox
 * Anything not visible is reported as 404 (its existence is not revealed).
 */
function visibilityOf(permissions) {
  const has = p => (permissions instanceof Set ? permissions.has(p) : (permissions || []).includes(p));
  if (has('conversations.view_all')) return 'all';
  if (has('conversations.view_assigned')) return 'assigned';
  return null;
}

function requireInboxAccess(req, _res, next) {
  if (visibilityOf(req.permissions)) return next();
  next(forbidden());
}

/** Restrict a conversations query (alias "c") to what the member may see. */
function scopeConversations(query, { visibility, membershipId }) {
  if (visibility === 'all') return query;
  if (visibility === 'assigned' && membershipId) return query.where('c.assigned_membership_id', membershipId);
  return query.whereRaw('false');
}

/** Socket.IO authoriser for the "conversation" room. Uses only server-held socket data. */
function conversationRoomAuthorizer(db) {
  return async (data, conversationId) => {
    const visibility = visibilityOf(data.permissions);
    if (!visibility || !data.companyId) return false;
    const row = await db.withContext({ companyId: data.companyId, userId: data.userId }, trx =>
      scopeConversations(trx('conversations as c').where('c.id', conversationId), { visibility, membershipId: data.membershipId }).first('c.id'));
    return Boolean(row);
  };
}

module.exports = { visibilityOf, requireInboxAccess, scopeConversations, conversationRoomAuthorizer };
