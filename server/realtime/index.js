const { Server } = require('socket.io');
const { COOKIE, parseCookies, resolveSession } = require('../middleware/session');

/**
 * Real-time events over Socket.IO, authenticated with the existing session cookie.
 *
 * Security model
 *  - Handshake: the httpOnly session cookie is resolved with the SAME function the HTTP API uses
 *    (expiry, disabled accounts, company status, membership status, permissions).
 *  - Origin check: browsers must present an allowed Origin (prevents cross-site WebSocket hijacking,
 *    since cookies are sent automatically).
 *  - Rooms are computed by the server only; clients never choose a company or room name:
 *      user:<userId>, session:<sessionId>, company:<companyId>, company:<companyId>:perm:<permission>,
 *      platform (Super Admin console sessions only).
 *  - Emitting requires a permission: emitToCompany(companyId, event, payload, { permission })
 *    reaches only members holding it. Payloads should carry ids; clients fetch details through
 *    the API, which re-checks authorisation.
 *  - Sessions are re-validated every REALTIME_REVALIDATE_SECONDS; sockets whose session ended or
 *    whose company access changed are disconnected, and permission rooms are refreshed.
 *  - Client-initiated room subscriptions go through registered authorisers (none in Phase 3.1,
 *    so every request is refused). Phase 3.2 registers "conversation".
 *  - Multi-instance: optional @socket.io/postgres-adapter (LISTEN/NOTIFY) — no Redis needed.
 */
const SESSION_ROOM = id => `session:${id}`;
const USER_ROOM = id => `user:${id}`;
const COMPANY_ROOM = id => `company:${id}`;
const PERMISSION_ROOM = (id, perm) => `company:${id}:perm:${perm}`;
const PLATFORM_ROOM = 'platform';

function createRealtime({ httpServer, db, config, logger = console }) {
  const allowed = new Set(config.realtime.allowedOrigins);
  const io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    cors: { origin: [...allowed], credentials: true },
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, Boolean(origin && allowed.has(origin)));
    },
    maxHttpBufferSize: 64 * 1024,
    connectionStateRecovery: undefined
  });

  let adapterPool = null;
  if (config.realtime.adapter === 'postgres') {
    const { Pool } = require('pg');
    const { createAdapter } = require('@socket.io/postgres-adapter');
    adapterPool = new Pool({ connectionString: config.databaseDirectUrl, max: 2, application_name: 'sscrm-realtime' });
    adapterPool.on('error', error => logger.error('[realtime] adapter pool error:', error.code || error.message));
    io.adapter(createAdapter(adapterPool, { tableName: 'socket_io_attachments' }));
  }

  const roomAuthorizers = new Map(); // name → async (socketData, id) => boolean

  function roomsFor(auth) {
    const rooms = [USER_ROOM(auth.user.id), SESSION_ROOM(auth.session.id)];
    if (auth.isPlatformSession) rooms.push(PLATFORM_ROOM);
    else if (auth.company) {
      rooms.push(COMPANY_ROOM(auth.company.id));
      for (const p of auth.permissions) rooms.push(PERMISSION_ROOM(auth.company.id, p));
    }
    return rooms;
  }

  io.use(async (socket, next) => {
    try {
      const token = parseCookies(socket.request.headers.cookie)[COOKIE];
      const auth = await resolveSession(db, token);
      if (!auth) return next(Object.assign(new Error('auth.required'), { data: { code: 'auth.required' } }));
      if (!auth.isPlatformSession && !auth.company) return next(Object.assign(new Error('company.no_access'), { data: { code: 'company.no_access' } }));
      socket.data = {
        token, // kept server-side only, for re-validation
        sessionId: auth.session.id,
        userId: auth.user.id,
        companyId: auth.company?.id || null,
        platform: auth.isPlatformSession,
        permissions: [...auth.permissions].sort()
      };
      next();
    } catch (error) {
      logger.error('[realtime] handshake error:', error.code || error.message);
      next(Object.assign(new Error('server_error'), { data: { code: 'common.server_error' } }));
    }
  });

  io.on('connection', socket => {
    const d = socket.data;
    const auth = { user: { id: d.userId }, session: { id: d.sessionId }, isPlatformSession: d.platform, company: d.companyId ? { id: d.companyId } : null, permissions: d.permissions };
    socket.join(roomsFor(auth));
    socket.emit('ready', { kind: d.platform ? 'platform' : 'company', companyId: d.companyId });

    // Client requests to follow a specific resource. The payload is never trusted for scoping.
    socket.on('subscribe', async (request, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const name = request && typeof request.room === 'string' ? request.room : '';
      const id = request && typeof request.id === 'string' ? request.id : '';
      const authorize = roomAuthorizers.get(name);
      if (!authorize || !/^[0-9a-f-]{36}$/i.test(id) || d.platform) return reply({ ok: false, code: 'realtime.forbidden' });
      try {
        if (!(await authorize(socket.data, id))) return reply({ ok: false, code: 'realtime.forbidden' });
        // Room names always include the server-known company id.
        await socket.join(`company:${d.companyId}:${name}:${id}`);
        reply({ ok: true });
      } catch {
        reply({ ok: false, code: 'realtime.forbidden' });
      }
    });
  });

  // ---- periodic re-validation of every local socket ----
  async function revalidate() {
    const sockets = [...io.of('/').sockets.values()];
    for (const socket of sockets) {
      try {
        const auth = await resolveSession(db, socket.data.token);
        const stillValid = auth && auth.isPlatformSession === socket.data.platform && (auth.company?.id || null) === socket.data.companyId
          && (auth.isPlatformSession || auth.company);
        if (!stillValid) { socket.disconnect(true); continue; }
        const perms = [...auth.permissions].sort();
        if (perms.join() !== socket.data.permissions.join()) {
          for (const p of socket.data.permissions) socket.leave(PERMISSION_ROOM(socket.data.companyId, p));
          for (const p of perms) socket.join(PERMISSION_ROOM(socket.data.companyId, p));
          socket.data.permissions = perms;
          socket.emit('session:changed');
        }
      } catch (error) {
        logger.error('[realtime] revalidation error:', error.code || error.message);
      }
    }
  }
  const timer = setInterval(revalidate, Math.max(1, config.realtime.revalidateSeconds) * 1000);
  timer.unref?.();

  return {
    io,
    revalidate,
    /** Register an authoriser for client subscriptions: (socketData, id) => Promise<boolean>. */
    registerRoom(name, authorize) {
      if (!/^[a-z_]{2,30}$/.test(name)) throw new Error('invalid room name');
      roomAuthorizers.set(name, authorize);
    },
    /** Emit to members of a company who hold `permission` (required). */
    emitToCompany(companyId, event, payload, { permission } = {}) {
      if (!companyId || !permission) throw new Error('emitToCompany requires companyId and permission');
      io.to(PERMISSION_ROOM(companyId, permission)).emit(event, payload);
    },
    emitToResource(companyId, name, id, event, payload) {
      io.to(`company:${companyId}:${name}:${id}`).emit(event, payload);
    },
    emitToUser(userId, event, payload) { io.to(USER_ROOM(userId)).emit(event, payload); },
    emitToPlatform(event, payload) { io.to(PLATFORM_ROOM).emit(event, payload); },
    /** Immediate disconnects (work across instances when the adapter is enabled). */
    disconnectSession(sessionId) { io.in(SESSION_ROOM(sessionId)).disconnectSockets(true); },
    disconnectUser(userId) { io.in(USER_ROOM(userId)).disconnectSockets(true); },
    disconnectCompany(companyId) { io.in(COMPANY_ROOM(companyId)).disconnectSockets(true); },
    connectedCount: () => io.of('/').sockets.size,
    async close() {
      clearInterval(timer);
      io.disconnectSockets(true);
      await new Promise(resolve => io.close(() => resolve()));
      if (adapterPool) await adapterPool.end().catch(() => {});
    }
  };
}

module.exports = { createRealtime };
