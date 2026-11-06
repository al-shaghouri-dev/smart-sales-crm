/** API representations of messaging rows. Storage keys and credentials are never exposed. */

const attachmentOut = a => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size, kind: a.kind, omitted: a.omitted || undefined });

function messageOut(m) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    direction: m.direction,
    senderType: m.sender_type,
    senderMembershipId: m.sender_membership_id,
    senderName: m.sender_name || null,
    type: m.type,
    body: m.body,
    attachments: (Array.isArray(m.attachments) ? m.attachments : []).map(attachmentOut),
    status: m.status,
    errorCode: m.error_code,
    clientMessageId: m.client_message_id,
    createdAt: m.created_at,
    sentAt: m.sent_at,
    deliveredAt: m.delivered_at,
    readAt: m.read_at
  };
}

/** `windowHours` comes from the provider adapter (null = no reply window). */
function conversationOut(c, { windowHours = null, now = Date.now() } = {}) {
  let replyWindow = null;
  if (windowHours) {
    const expiresAt = c.last_inbound_at ? new Date(new Date(c.last_inbound_at).getTime() + windowHours * 3600 * 1000) : null;
    replyWindow = { hours: windowHours, open: Boolean(expiresAt && expiresAt.getTime() > now), expiresAt };
  }
  return {
    id: c.id,
    status: c.status,
    priority: c.priority,
    unreadCount: c.unread_count,
    lastMessagePreview: c.last_message_preview,
    lastMessageAt: c.last_message_at,
    lastInboundAt: c.last_inbound_at,
    lastOutboundAt: c.last_outbound_at,
    createdAt: c.created_at,
    assignedMembershipId: c.assigned_membership_id,
    assigneeName: c.assignee_name || null,
    channel: { id: c.channel_id, provider: c.channel_provider, displayName: c.channel_name, status: c.channel_status },
    contact: { id: c.contact_id, displayName: c.contact_name, phone: c.contact_phone || null, email: c.contact_email || null },
    identity: { id: c.identity_id, username: c.identity_profile?.username || null, externalUserId: c.identity_external_id },
    replyWindow
  };
}

module.exports = { messageOut, conversationOut, attachmentOut };
