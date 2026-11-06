import { io } from 'socket.io-client';

/**
 * Same-origin Socket.IO connection. Authentication is the httpOnly session cookie (sent
 * automatically); the client never sends a company id or chooses rooms — the server assigns them.
 * Status is mirrored on <html data-realtime="…"> for diagnostics and browser tests.
 */
let socket = null;
const listeners = new Map();

function setStatus(status) {
  document.documentElement.dataset.realtime = status;
}

export function connectRealtime() {
  if (socket) return socket;
  // Default transports: start with HTTP long-polling, then upgrade to WebSocket when the path
  // allows it. This keeps working behind proxies without WebSocket support (e.g. a static host
  // that forwards /socket.io to the Node server) instead of failing outright.
  socket = io({ path: '/socket.io', withCredentials: true });
  setStatus('connecting');
  socket.on('connect', () => setStatus('connected'));
  socket.on('disconnect', () => setStatus('disconnected'));
  socket.on('connect_error', () => setStatus('error'));
  for (const [event, handlers] of listeners) for (const h of handlers) socket.on(event, h);
  return socket;
}

export function disconnectRealtime() {
  if (!socket) return;
  socket.disconnect();
  socket = null;
  setStatus('off');
}

/** Subscribe to a server event; returns an unsubscribe function. */
export function onRealtime(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  socket?.on(event, handler);
  return () => { listeners.get(event)?.delete(handler); socket?.off(event, handler); };
}

/**
 * Follow one resource (e.g. a conversation). The server authorises every request and assigns the
 * room; subscriptions are renewed after a reconnect. Returns an unsubscribe function.
 */
const resources = new Map();
function sendSubscribe(key) {
  const [room, id] = key.split(':');
  socket?.emit('subscribe', { room, id }, () => {});
}
export function followResource(room, id) {
  const key = `${room}:${id}`;
  resources.set(key, (resources.get(key) || 0) + 1);
  if (socket?.connected) sendSubscribe(key);
  return () => {
    const n = (resources.get(key) || 1) - 1;
    if (n <= 0) resources.delete(key); else resources.set(key, n);
  };
}
onRealtime('connect', () => { for (const key of resources.keys()) sendSubscribe(key); });
