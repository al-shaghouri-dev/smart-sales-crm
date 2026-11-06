import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCheck, Clock, Download, FileText, Inbox as InboxIcon, Info, Loader2, MessageSquare, Paperclip, RotateCcw, Search, Send, X, Zap } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { followResource, onRealtime } from '../lib/realtime';
import { Badge, Button, EmptyState, ErrorState, IconButton, Modal, Spinner, useToast } from '../components/ui';

const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '•';
const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

function timeLabel(value, locale) {
  if (!value) return '';
  const d = new Date(value);
  const sameDay = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', sameDay ? { timeStyle: 'short' } : { dateStyle: 'short' }).format(d);
}

export const ProviderBadge = ({ provider }) => {
  const { t } = useTranslation();
  return <span className={`provider-badge provider-${provider}`}>{t(`channels.providers.${provider}`, { defaultValue: provider })}</span>;
};

function StatusTick({ message }) {
  const { t } = useTranslation();
  if (message.direction !== 'out') return null;
  const s = message.status;
  const label = t(`inbox.messageStatus.${s}`);
  if (s === 'failed') return <AlertCircle size={14} className="tick tick-failed" aria-label={label} />;
  if (s === 'queued' || s === 'sending') return <Clock size={13} className="tick" aria-label={label} />;
  if (s === 'sent') return <Check size={14} className="tick" aria-label={label} />;
  return <CheckCheck size={14} className={`tick ${s === 'read' ? 'tick-read' : ''}`} aria-label={label} />;
}

function Attachment({ conversationId, a }) {
  const { t } = useTranslation();
  const url = `/api/conversations/${conversationId}/attachments/${a.id}`;
  if (a.omitted) return <div className="attachment muted"><FileText size={16} aria-hidden />{t('inbox.attachmentOmitted')}</div>;
  if (a.kind === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(a.contentType)) {
    return <a href={url} target="_blank" rel="noreferrer" className="attachment-image"><img src={url} alt={a.name} loading="lazy" /></a>;
  }
  return (
    <a href={url} className="attachment" download>
      <FileText size={16} aria-hidden /><span className="attachment-name" dir="auto">{a.name}</span>
      <small className="muted">{Math.max(1, Math.round((a.size || 0) / 1024))} KB</small><Download size={14} aria-hidden />
    </a>
  );
}

// ---------------------------------------------------------------- list column
function ConversationList({ items, loading, error, reload, selectedId, onSelect, filters, setFilters, counts, canSeeAll, channels, hasMore, loadMore }) {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState(filters.search || '');
  useEffect(() => { const h = setTimeout(() => setFilters(f => (f.search === search ? f : { ...f, search })), 300); return () => clearTimeout(h); }, [search, setFilters]);
  return (
    <section className="inbox-list" aria-label={t('inbox.conversations')}>
      <div className="inbox-list-head">
        <div className="segmented" role="tablist">
          {['open', 'pending', 'closed'].map(s => (
            <button key={s} type="button" role="tab" aria-selected={filters.status === s} className={filters.status === s ? 'active' : ''}
              onClick={() => setFilters(f => ({ ...f, status: s }))}>
              {t(`inbox.status.${s}`)}{s !== 'closed' && counts?.[s] ? <span className="count">{counts[s]}</span> : null}
            </button>
          ))}
        </div>
        <div className="search-box">
          <Search size={16} aria-hidden />
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('inbox.search')} aria-label={t('inbox.search')} />
        </div>
        <div className="row filters-row">
          {canSeeAll && (
            <select value={filters.assigned} onChange={e => setFilters(f => ({ ...f, assigned: e.target.value }))} aria-label={t('inbox.assignedFilter')}>
              <option value="">{t('inbox.filter.all')}</option>
              <option value="me">{t('inbox.filter.mine')}</option>
              <option value="unassigned">{t('inbox.filter.unassigned')}</option>
            </select>
          )}
          {channels.length > 1 && (
            <select value={filters.channelId} onChange={e => setFilters(f => ({ ...f, channelId: e.target.value }))} aria-label={t('inbox.channelFilter')}>
              <option value="">{t('inbox.filter.allChannels')}</option>
              {channels.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}
            </select>
          )}
        </div>
      </div>
      <div className="inbox-list-body">
        {loading && !items.length ? <Spinner /> : error ? <ErrorState error={error} onRetry={reload} /> : !items.length ? (
          <EmptyState icon={InboxIcon} title={t('inbox.emptyTitle')}>{t('inbox.emptyBody')}</EmptyState>
        ) : (
          <ul className="conv-items">
            {items.map(c => (
              <li key={c.id}>
                <button type="button" className={`conv-item ${c.id === selectedId ? 'active' : ''} ${c.unreadCount ? 'unread' : ''}`} onClick={() => onSelect(c.id)}>
                  <span className="avatar" aria-hidden>{initials(c.contact.displayName)}</span>
                  <span className="conv-main">
                    <span className="conv-top">
                      <strong dir="auto">{c.contact.displayName}</strong>
                      <time className="muted small">{timeLabel(c.lastMessageAt || c.createdAt, i18n.language)}</time>
                    </span>
                    <span className="conv-bottom">
                      <span className="conv-preview muted" dir="auto">{c.lastMessagePreview || '—'}</span>
                      {c.unreadCount > 0 && <span className="unread-dot" aria-label={t('inbox.unreadCount', { count: c.unreadCount })}>{c.unreadCount}</span>}
                    </span>
                    <span className="conv-meta">
                      <ProviderBadge provider={c.channel.provider} />
                      {c.priority !== 'normal' && <Badge tone={c.priority === 'urgent' || c.priority === 'high' ? 'danger' : 'neutral'}>{t(`inbox.priority.${c.priority}`)}</Badge>}
                      {c.assigneeName && <span className="muted small assignee">{c.assigneeName}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasMore && <div className="load-more"><Button size="sm" variant="ghost" onClick={loadMore}>{t('inbox.loadMore')}</Button></div>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- approved templates (WhatsApp)
function TemplateModal({ conversation, onClose, onSent }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [state, setState] = useState({ loading: true, items: [], error: null });
  const [chosen, setChosen] = useState(null);
  const [params, setParams] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/api/channels/${conversation.channel.id}/templates`).then(r => setState({ loading: false, items: r.templates })).catch(error => setState({ loading: false, items: [], error })); }, [conversation.channel.id]);
  const preview = chosen ? chosen.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] || `{{${n}}}`) : '';
  async function send() {
    setBusy(true);
    try {
      const r = await api.post(`/api/conversations/${conversation.id}/messages`, { template: { name: chosen.name, language: chosen.language, params }, templatePreview: preview, clientMessageId: newClientId() });
      onSent(r.message); onClose();
    } catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('inbox.templates')} onClose={onClose} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={!chosen || params.some(p => !p.trim())} loading={busy} onClick={send}>{t('inbox.send')}</Button></>}>
      {state.loading ? <Spinner /> : state.error ? <div className="alert alert-error">{errorMessage(t, state.error)}</div> : !state.items.length ? <p className="muted">{t('inbox.noTemplates')}</p> : (
        <div className="stack">
          <select value={chosen ? `${chosen.name}|${chosen.language}` : ''} aria-label={t('inbox.templates')}
            onChange={e => { const x = state.items.find(i => `${i.name}|${i.language}` === e.target.value); setChosen(x || null); setParams(Array(x?.params || 0).fill('')); }}>
            <option value="">{t('inbox.chooseTemplate')}</option>
            {state.items.map(i => <option key={`${i.name}|${i.language}`} value={`${i.name}|${i.language}`}>{i.name} · {i.language}</option>)}
          </select>
          {params.map((p, i) => <input key={i} value={p} dir="auto" placeholder={`{{${i + 1}}}`} onChange={e => setParams(list => list.map((x, j) => (j === i ? e.target.value : x)))} />)}
          {chosen && <div className="bubble template-preview" dir="auto">{preview}</div>}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- thread column
function Thread({ conversation, onBack, onToggleDetails, onChanged }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { can } = useApp();
  const [messages, setMessages] = useState([]);
  const [state, setState] = useState({ loading: true, error: null, hasMore: false });
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [quick, setQuick] = useState(null);
  const [showQuick, setShowQuick] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const scroller = useRef(null);
  const fileInput = useRef(null);
  const id = conversation.id;
  const rtl = i18n.dir() === 'rtl';

  const scrollToEnd = () => requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
  const upsert = useCallback(m => setMessages(list => {
    const i = list.findIndex(x => x.id === m.id || (m.clientMessageId && x.clientMessageId === m.clientMessageId));
    if (i === -1) return [...list, m];
    const next = list.slice(); next[i] = { ...list[i], ...m }; return next;
  }), []);

  useEffect(() => {
    let alive = true;
    setMessages([]); setState({ loading: true, error: null, hasMore: false }); setText(''); setFile(null);
    api.get(`/api/conversations/${id}/messages`).then(r => {
      if (!alive) return;
      setMessages(r.messages); setState({ loading: false, error: null, hasMore: r.hasMore }); scrollToEnd();
    }).catch(error => alive && setState({ loading: false, error, hasMore: false }));
    if (conversation.unreadCount > 0) api.post(`/api/conversations/${id}/read`).then(() => onChanged({ ...conversation, unreadCount: 0 })).catch(() => {});
    const unfollow = followResource('conversation', id);
    const offNew = onRealtime('message:new', p => { if (p.conversationId === id) { upsert(p.message); scrollToEnd(); if (p.message.direction === 'in') api.post(`/api/conversations/${id}/read`).catch(() => {}); } });
    const offUpd = onRealtime('message:updated', p => { if (p.conversationId === id) upsert(p.message); });
    return () => { alive = false; unfollow(); offNew(); offUpd(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadOlder() {
    const first = messages[0];
    if (!first) return;
    const before = scroller.current?.scrollHeight || 0;
    const r = await api.get(`/api/conversations/${id}/messages?before=${first.id}`);
    setMessages(list => [...r.messages, ...list]);
    setState(s => ({ ...s, hasMore: r.hasMore }));
    requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight - before; });
  }

  async function send(e) {
    e?.preventDefault();
    const body = text.trim();
    if ((!body && !file) || sending) return;
    const clientMessageId = newClientId();
    setSending(true);
    try {
      let res;
      if (file) {
        const fd = new FormData();
        fd.append('text', body); fd.append('clientMessageId', clientMessageId); fd.append('file', file);
        res = await api.post(`/api/conversations/${id}/messages`, fd);
      } else {
        res = await api.post(`/api/conversations/${id}/messages`, { text: body, clientMessageId });
      }
      upsert(res.message); setText(''); setFile(null); scrollToEnd();
    } catch (err) {
      toast.error(errorMessage(t, err));
    } finally { setSending(false); }
  }

  async function retry(m) {
    try { upsert((await api.post(`/api/conversations/${id}/messages/${m.id}/retry`)).message); } catch (err) { toast.error(errorMessage(t, err)); }
  }

  async function openQuick() {
    setShowQuick(v => !v);
    if (quick === null) { try { setQuick((await api.get('/api/conversations/quick-replies')).quickReplies); } catch { setQuick([]); } }
  }

  const windowClosed = conversation.replyWindow && !conversation.replyWindow.open;
  const channelDown = conversation.channel.status !== 'active';
  const canReply = can('conversations.reply');
  const Back = rtl ? ArrowRight : ArrowLeft;

  return (
    <section className="inbox-thread" aria-label={conversation.contact.displayName}>
      <header className="thread-head">
        <IconButton label={t('common.back')} onClick={onBack} className="only-mobile"><Back size={18} /></IconButton>
        <span className="avatar" aria-hidden>{initials(conversation.contact.displayName)}</span>
        <div className="thread-title">
          <strong dir="auto">{conversation.contact.displayName}</strong>
          <span className="muted small"><ProviderBadge provider={conversation.channel.provider} /> {conversation.channel.displayName}</span>
        </div>
        <Badge tone={conversation.status === 'open' ? 'success' : conversation.status === 'pending' ? 'warning' : 'neutral'}>{t(`inbox.status.${conversation.status}`)}</Badge>
        <IconButton label={t('inbox.details')} onClick={onToggleDetails} className="details-toggle"><Info size={18} /></IconButton>
      </header>

      <div className="thread-body" ref={scroller}>
        {state.loading ? <Spinner /> : state.error ? <ErrorState error={state.error} /> : (
          <>
            {state.hasMore && <div className="load-more"><Button size="sm" variant="ghost" onClick={loadOlder}>{t('inbox.loadOlder')}</Button></div>}
            {!messages.length && <EmptyState icon={MessageSquare} title={t('inbox.noMessages')} />}
            {messages.map(m => (
              <div key={m.id} className={`bubble-row ${m.direction === 'out' ? 'out' : 'in'}`}>
                <div className={`bubble ${m.status === 'failed' ? 'failed' : ''}`}>
                  {m.direction === 'out' && m.senderName && <div className="bubble-sender">{m.senderName}</div>}
                  {m.attachments.map(a => <Attachment key={a.id} conversationId={id} a={a} />)}
                  {m.body && <div className="bubble-text" dir="auto">{m.body}</div>}
                  {m.type === 'unsupported' && !m.body && <div className="muted small">{t('inbox.unsupported')}</div>}
                  <div className="bubble-foot">
                    <time>{timeLabel(m.createdAt, i18n.language)}</time>
                    <StatusTick message={m} />
                  </div>
                  {m.status === 'failed' && (
                    <div className="bubble-error">
                      <span>{t(`errors.${m.errorCode}`, { defaultValue: t('inbox.sendFailed') })}</span>
                      {canReply && <button type="button" onClick={() => retry(m)}><RotateCcw size={13} aria-hidden />{t('common.retry')}</button>}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {canReply && (
        <form className="composer" onSubmit={send}>
          {(windowClosed || channelDown) && (
            <div className="alert alert-info composer-note"><AlertCircle size={16} aria-hidden />{channelDown ? t('inbox.channelDown') : t('inbox.windowClosed', { hours: conversation.replyWindow.hours })}
              {!channelDown && conversation.channel.templates && <Button size="sm" variant="primary" type="button" onClick={() => setShowTemplates(true)}>{t('inbox.sendTemplate')}</Button>}</div>
          )}
          {showTemplates && <TemplateModal conversation={conversation} onClose={() => setShowTemplates(false)} onSent={m => { upsert(m); scrollToEnd(); }} />}
          {file && (
            <div className="composer-file"><Paperclip size={14} aria-hidden /><span dir="auto">{file.name}</span>
              <IconButton label={t('common.remove')} onClick={() => setFile(null)}><X size={14} /></IconButton></div>
          )}
          {showQuick && (
            <div className="quick-replies">
              {quick === null ? <Loader2 className="spin" size={16} /> : !quick.length ? <span className="muted small">{t('inbox.noQuickReplies')}</span> :
                quick.map((q, i) => <button key={i} type="button" className="quick-reply" dir="auto" onClick={() => { setText(v => (v ? `${v} ${q}` : q)); setShowQuick(false); }}>{q}</button>)}
            </div>
          )}
          <div className="composer-row">
            <IconButton label={t('inbox.quickReplies')} onClick={openQuick}><Zap size={18} /></IconButton>
            <IconButton label={t('inbox.attach')} onClick={() => fileInput.current?.click()} disabled={windowClosed || channelDown}><Paperclip size={18} /></IconButton>
            <input ref={fileInput} type="file" hidden onChange={e => { setFile(e.target.files?.[0] || null); e.target.value = ''; }} />
            <textarea value={text} rows={1} dir="auto" maxLength={4096} placeholder={t('inbox.typeMessage')} aria-label={t('inbox.typeMessage')}
              disabled={windowClosed || channelDown}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
            <Button variant="primary" type="submit" loading={sending} disabled={(!text.trim() && !file) || windowClosed || channelDown} aria-label={t('inbox.send')}>
              <Send size={16} aria-hidden className="flip-rtl" /><span className="hide-sm">{t('inbox.send')}</span>
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- details column
function Details({ conversation, onChanged, onClose }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { can } = useApp();
  const [assignees, setAssignees] = useState(null);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const id = conversation.id;

  useEffect(() => {
    if (can('conversations.assign')) api.get('/api/conversations/assignees').then(r => setAssignees(r.assignees)).catch(() => setAssignees([]));
    api.get(`/api/conversations/${id}/assignments`).then(r => setHistory(r.assignments)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, conversation.assignedMembershipId]);

  async function patch(body) {
    setBusy(true);
    try { onChanged((await api.patch(`/api/conversations/${id}`, body)).conversation); } catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }
  async function assign(membershipId) {
    setBusy(true);
    try { onChanged((await api.post(`/api/conversations/${id}/assign`, { membershipId: membershipId || null })).conversation); toast.success(t('inbox.assigned')); }
    catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }

  const c = conversation;
  const canEdit = can('conversations.reply') || can('conversations.assign');
  return (
    <aside className="inbox-details" aria-label={t('inbox.details')}>
      <div className="details-head">
        <h2>{t('inbox.details')}</h2>
        <IconButton label={t('common.close')} onClick={onClose} className="details-close"><X size={18} /></IconButton>
      </div>
      <div className="details-contact">
        <span className="avatar lg" aria-hidden>{initials(c.contact.displayName)}</span>
        <strong dir="auto">{c.contact.displayName}</strong>
        {c.identity.username && <span className="muted small" dir="ltr">@{c.identity.username}</span>}
        <ProviderBadge provider={c.channel.provider} />
      </div>
      <dl className="details-list">
        {c.contact.phone && <><dt>{t('inbox.phone')}</dt><dd dir="ltr">{c.contact.phone}</dd></>}
        {c.contact.email && <><dt>{t('inbox.email')}</dt><dd dir="ltr">{c.contact.email}</dd></>}
        <dt>{t('inbox.channel')}</dt><dd>{c.channel.displayName}</dd>
        <dt>{t('inbox.started')}</dt><dd>{timeLabel(c.createdAt, i18n.language)}</dd>
        {c.replyWindow && <><dt>{t('inbox.replyWindow')}</dt><dd>{c.replyWindow.open ? t('inbox.windowOpenUntil', { time: timeLabel(c.replyWindow.expiresAt, i18n.language) }) : t('inbox.windowClosedShort')}</dd></>}
      </dl>

      <div className="details-section">
        <label className="label" htmlFor="conv-status">{t('inbox.statusLabel')}</label>
        <select id="conv-status" value={c.status} disabled={!canEdit || busy} onChange={e => patch({ status: e.target.value })}>
          {['open', 'pending', 'closed'].map(s => <option key={s} value={s}>{t(`inbox.status.${s}`)}</option>)}
        </select>
        <label className="label" htmlFor="conv-priority">{t('inbox.priorityLabel')}</label>
        <select id="conv-priority" value={c.priority} disabled={!canEdit || busy} onChange={e => patch({ priority: e.target.value })}>
          {['low', 'normal', 'high', 'urgent'].map(p => <option key={p} value={p}>{t(`inbox.priority.${p}`)}</option>)}
        </select>
        <label className="label" htmlFor="conv-assignee">{t('inbox.assignee')}</label>
        {can('conversations.assign') ? (
          <select id="conv-assignee" value={c.assignedMembershipId || ''} disabled={busy || assignees === null} onChange={e => assign(e.target.value)}>
            <option value="">{t('inbox.unassigned')}</option>
            {(assignees || []).map(a => <option key={a.membershipId} value={a.membershipId}>{a.name}</option>)}
          </select>
        ) : <p>{c.assigneeName || t('inbox.unassigned')}</p>}
      </div>

      {history.length > 0 && (
        <div className="details-section">
          <h3 className="label">{t('inbox.assignmentHistory')}</h3>
          <ul className="history">
            {history.map(h => <li key={h.id}><span>{h.toName ? t('inbox.assignedTo', { name: h.toName }) : t('inbox.unassignedEvent')}</span>
              <small className="muted">{h.byName ? `${h.byName} · ` : ''}{timeLabel(h.at, i18n.language)}</small></li>)}
          </ul>
        </div>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------- page
export default function Inbox() {
  const { t } = useTranslation();
  const { can, me } = useApp();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('c');
  const canSeeAll = can('conversations.view_all');
  const [filters, setFilters] = useState({ status: 'open', search: '', assigned: '', channelId: '' });
  const [list, setList] = useState({ items: [], loading: true, error: null, nextCursor: null, counts: null });
  const [channels, setChannels] = useState([]);
  const [selected, setSelected] = useState(null);
  const [showDetails, setShowDetails] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams({ status: filters.status });
    if (filters.search) p.set('search', filters.search);
    if (filters.assigned) p.set('assigned', filters.assigned);
    if (filters.channelId) p.set('channelId', filters.channelId);
    return p.toString();
  }, [filters]);

  const load = useCallback(async () => {
    setList(l => ({ ...l, loading: true, error: null }));
    try {
      const r = await api.get(`/api/conversations?${query}`);
      setList({ items: r.conversations, loading: false, error: null, nextCursor: r.nextCursor, counts: r.counts });
    } catch (error) { setList(l => ({ ...l, loading: false, error })); }
  }, [query]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/api/channels').then(r => setChannels(r.channels)).catch(() => {}); }, []);

  async function loadMore() {
    const r = await api.get(`/api/conversations?${query}&cursor=${encodeURIComponent(list.nextCursor)}`);
    setList(l => ({ ...l, items: [...l.items, ...r.conversations.filter(c => !l.items.some(x => x.id === c.id))], nextCursor: r.nextCursor }));
  }

  const matches = useCallback(c => c.status === filters.status && (!filters.channelId || c.channel.id === filters.channelId)
    && (filters.assigned !== 'me' || c.assignedMembershipId === me.membership?.id) && (filters.assigned !== 'unassigned' || !c.assignedMembershipId), [filters, me.membership]);

  const applyConversation = useCallback(c => {
    setList(l => {
      const others = l.items.filter(x => x.id !== c.id);
      const items = matches(c) && !filters.search ? [c, ...others].sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt)) : (filters.search ? l.items.map(x => (x.id === c.id ? c : x)) : others);
      return { ...l, items };
    });
    setSelected(s => (s && s.id === c.id ? c : s));
  }, [matches, filters.search]);

  // Live updates: refetch the changed conversation through the API (which re-checks access).
  useEffect(() => onRealtime('conversation:updated', async p => {
    if (p.companyId !== me.company?.id) return;
    try { applyConversation((await api.get(`/api/conversations/${p.conversationId}`)).conversation); }
    catch { setList(l => ({ ...l, items: l.items.filter(x => x.id !== p.conversationId) })); setSelected(s => (s?.id === p.conversationId ? null : s)); }
  }), [applyConversation, me.company]);

  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    const local = list.items.find(c => c.id === selectedId);
    if (local) { setSelected(local); return; }
    api.get(`/api/conversations/${selectedId}`).then(r => setSelected(r.conversation)).catch(() => { setSelected(null); setParams({}, { replace: true }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const select = id => setParams({ c: id });

  if (!channels.length && !list.loading && !list.items.length && filters.status === 'open' && !filters.search) {
    return (
      <div className="inbox-empty-page">
        <EmptyState icon={MessageSquare} title={t('inbox.noChannelsTitle')}>{t('inbox.noChannelsBody')}</EmptyState>
        {can('channels.manage') && <Link to="/channels" className="btn btn-primary">{t('inbox.connectChannel')}</Link>}
      </div>
    );
  }

  return (
    <div className={`inbox ${selected ? 'has-selection' : ''} ${showDetails ? 'show-details' : ''}`}>
      <ConversationList items={list.items} loading={list.loading} error={list.error} reload={load} selectedId={selectedId} onSelect={select}
        filters={filters} setFilters={setFilters} counts={list.counts} canSeeAll={canSeeAll} channels={channels}
        hasMore={Boolean(list.nextCursor)} loadMore={loadMore} />
      {selected ? (
        <>
          <Thread key={selected.id} conversation={selected} onBack={() => setParams({})} onToggleDetails={() => setShowDetails(v => !v)} onChanged={applyConversation} />
          <Details conversation={selected} onChanged={applyConversation} onClose={() => setShowDetails(false)} />
        </>
      ) : (
        <div className="inbox-placeholder"><EmptyState icon={MessageSquare} title={t('inbox.selectTitle')}>{t('inbox.selectBody')}</EmptyState></div>
      )}
    </div>
  );
}
