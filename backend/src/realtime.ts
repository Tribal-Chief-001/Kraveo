import { errSummary } from './utils/log';
import { SlidingWindow } from './middleware/rateLimit';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { prisma } from './db';
import { verifyTokenForAccount } from './middleware/auth';
import { orderView, isPoolEligible, OrderWithRelations, ORDER_VIEW_INCLUDE, ACTIVE_RIDER_STATUSES } from './services/orderView';

/**
 * Socket.io (Docs/16_order_flow_contract.md section 3).
 *
 * Rooms and who may be in them (always checked on the server):
 *   user_<userId>     every socket of that user (joined automatically; used to kick a suspended partner)
 *   admins            ADMIN (automatic)
 *   drivers           approved DRIVER (automatic on connect, re-checked on join_room)
 *   vendor_<vendorId> the owner of that restaurant (automatic on connect, or join_room)
 *   order_<orderId>   owner customer, owning restaurant (paid orders only), assigned rider, ADMIN
 *
 * Orders are NEVER broadcast as one object: every socket gets orderView() for its own role and id,
 * and a socket that may no longer see the order (released rider, ...) gets nothing and leaves the room.
 */
let ioRef: SocketIOServer | null = null;
export const getIo = () => ioRef;

type SocketUser = { id: string; role: string };

/**
 * join_room limits, per socket. Every order_<id> join runs a database query with all relations, so a loop of joins is a
 * cheap way to load the server. Sized from the three apps (the socket services of the customer, restaurant and rider apps):
 * they join ONE room per active order, again after every reconnect (a NEW socket, so a fresh budget), and retry a refused
 * join on their next poll/sync (every ~15 s). A customer or rider has a handful of active orders, so
 * 30 joins per minute is several times what a legitimate client emits, while a flood is cut off quickly.
 * The apps never emit leave_room, so a long-lived rider socket would keep every finished order room: instead of refusing
 * a join at the cap, the OLDEST order room is dropped (finished orders are the oldest), keeping at most 10 order rooms.
 */
export const JOIN_LIMIT = { max: 30, windowMs: 60_000 };
export const MAX_ORDER_ROOMS_PER_SOCKET = 10;
const joinWindows = new SlidingWindow();

/** Registers a successful order_<id> join on the socket and drops the oldest order room when over the cap. */
const trackOrderRoom = (socket: Socket, room: string) => {
  const rooms: string[] = (socket.data.orderRooms as string[] | undefined) ?? [];
  const at = rooms.indexOf(room);
  if (at >= 0) rooms.splice(at, 1);
  rooms.push(room);
  while (rooms.length > MAX_ORDER_ROOMS_PER_SOCKET) {
    const oldest = rooms.shift()!;
    socket.leave(oldest);
  }
  socket.data.orderRooms = rooms;
};
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isApprovedRider = async (userId: string) => {
  const d = await prisma.driverPartner.findUnique({ where: { userId }, select: { approvalStatus: true } });
  return d?.approvalStatus === 'APPROVED';
};

/** The `drivers` room (order offers) is for approved riders who are on duty. */
const isRiderOnDuty = async (userId: string) => {
  const d = await prisma.driverPartner.findUnique({ where: { userId }, select: { approvalStatus: true, dutyStatus: true } });
  return d?.approvalStatus === 'APPROVED' && d.dutyStatus !== 'OFFLINE';
};

const isValidCoordinate = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
  typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;

/** May this user be in order_<id>? Same rule as orderView, but a rider must be the assigned one (no pool riders). */
const canWatchOrder = (order: OrderWithRelations, user: SocketUser) => {
  if (user.role === 'DRIVER' && order.driverId !== user.id) return false;
  return orderView(order, user.role, user.id) !== null;
};

const canJoin = async (room: string, user: SocketUser): Promise<boolean> => {
  if (room === 'admins') return user.role === 'ADMIN';
  if (room === 'drivers') return user.role === 'DRIVER' && (await isRiderOnDuty(user.id));
  if (room.startsWith('vendor_')) {
    if (user.role === 'ADMIN') return true;
    if (user.role !== 'VENDOR') return false;
    const vendorId = room.slice('vendor_'.length);
    if (!ORDER_ID_RE.test(vendorId)) return false;
    // Only an APPROVED restaurant: a suspended / pending / rejected owner hears nothing about orders.
    return Boolean(await prisma.vendor.findFirst({ where: { id: vendorId, userId: user.id, approvalStatus: 'APPROVED' }, select: { id: true } }));
  }
  if (room.startsWith('order_')) {
    const orderId = room.slice('order_'.length);
    if (!ORDER_ID_RE.test(orderId)) return false;
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_VIEW_INCLUDE });
    return Boolean(order && canWatchOrder(order, user));
  }
  return false; // user_* and anything else cannot be joined on request
};

export const attachRealtime = (io: SocketIOServer) => {
  ioRef = io;

  // No token -> no connection. The handshake also decides the automatic rooms.
  io.use(async (socket, next) => {
    try {
      const rawToken = socket.handshake.auth?.token;
      if (typeof rawToken !== 'string' || !rawToken.trim()) return next(new Error('Authentication required.'));
      // Signature + the account still exists + the token was not revoked (password reset, suspension, deletion).
      const decoded = await verifyTokenForAccount(rawToken.replace(/^Bearer\s+/i, ''));
      socket.data.user = { id: decoded.id, role: decoded.role } as SocketUser;
      const autoRooms = [`user_${decoded.id}`];
      if (decoded.role === 'ADMIN') autoRooms.push('admins');
      if (decoded.role === 'DRIVER' && (await isRiderOnDuty(decoded.id))) autoRooms.push('drivers');
      if (decoded.role === 'VENDOR') {
        const owned = await prisma.vendor.findMany({ where: { userId: decoded.id, approvalStatus: 'APPROVED' }, select: { id: true } });
        autoRooms.push(...owned.map((v) => `vendor_${v.id}`));
      }
      socket.data.autoRooms = autoRooms;
      // Docs/22: a rider app that understands combined orders says so (`auth: { token, groups: 1 }`); only those sockets are offered a combined order.
      const g = socket.handshake.auth?.groups ?? socket.handshake.query?.groups;
      socket.data.groups = g === 1 || g === true || g === '1' || g === 'true';
      return next();
    } catch {
      return next(new Error('Invalid or expired authentication token.'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as SocketUser;
    socket.join(socket.data.autoRooms as string[]);
    socket.on('disconnect', () => joinWindows.delete(socket.id));

    // join_room(room, ack?) -> ack({ ok }) so a client knows when it is actually subscribed.
    socket.on('join_room', async (room: unknown, ack?: unknown) => {
      let ok = false;
      const allowed = joinWindows.hit(socket.id, JOIN_LIMIT.max, JOIN_LIMIT.windowMs);
      if (!allowed.ok) {
        // Polite refusal, no database work. The apps treat {ok:false} as "not joined" and keep polling over REST.
        if (typeof ack === 'function') ack({ ok: false, code: 'RATE_LIMITED', message: 'Too many room requests. Please wait a minute.', retryAfterSeconds: allowed.retryAfterSeconds });
        return;
      }
      try {
        if (typeof room === 'string' && room.length <= 100) ok = await canJoin(room, user);
        if (ok) {
          socket.join(room as string);
          if ((room as string).startsWith('order_')) trackOrderRoom(socket, room as string);
        }
      } catch (err) {
        console.error('join_room failed:', errSummary(err));
        ok = false;
      }
      if (typeof ack === 'function') ack({ ok });
    });

    socket.on('leave_room', (room: unknown) => {
      if (typeof room === 'string' && !room.startsWith('user_')) socket.leave(room);
    });

    // Riders may stream their position over the socket instead of POST /drivers/location. The rider id
    // always comes from the token (no spoofing) and the position only goes to admins and to the customer
    // of the rider's active order (never to restaurants or other riders).
    socket.on('update_driver_location', async (data: any) => {
      if (user.role !== 'DRIVER' || !data || typeof data !== 'object') return;
      const now = Date.now();
      if (now - (socket.data.lastLocationAt ?? 0) < 2000) return; // at most one fix every 2 s per socket
      socket.data.lastLocationAt = now;
      try {
        await recordRiderLocation(user.id, data.lat, data.lng, data.heading);
      } catch {
        // invalid input or not an approved rider: ignore silently (the REST endpoint reports errors)
      }
    });
  });
};

/** Sockets of `userId` join `rooms` now (a rider going on duty). The caller has already checked they may. */
export const addToPartnerRooms = (userId: string, rooms: string[]) => {
  try {
    ioRef?.in(`user_${userId}`).socketsJoin(rooms);
  } catch (err) {
    console.error('addToPartnerRooms failed:', errSummary(err));
  }
};

/** Sockets of `userId` leave `rooms` now (used when a partner is suspended or a rider goes off duty). */
export const dropFromPartnerRooms = async (userId: string, rooms: string[]) => {
  try {
    ioRef?.in(`user_${userId}`).socketsLeave(rooms);
  } catch (err) {
    console.error('dropFromPartnerRooms failed:', errSummary(err));
  }
};

/**
 * Tell everyone who may know that an order changed.
 * - order_updated: order room + admins + the restaurant room, one per socket, built for that socket.
 * - new_order_alert: restaurant room + admins (only when a payment just made the order live).
 * - order_available / order_unavailable: the drivers room, when the order enters / leaves the pool.
 * Never throws: a socket problem must not fail the request that changed the order.
 */
export const publishOrderChange = async (order: OrderWithRelations, opts: { wasPoolEligible?: boolean; newOrderAlert?: boolean } = {}) => {
  const io = ioRef;
  if (!io) return;
  try {
    const orderRoom = `order_${order.id}`;
    const vendorRoom = `vendor_${order.vendorId}`;
    const sockets = await io.in([orderRoom, 'admins', vendorRoom]).fetchSockets();
    for (const s of sockets) {
      const u = s.data.user as SocketUser | undefined;
      if (!u) continue;
      const view = u.role === 'DRIVER' && order.driverId !== u.id ? null : orderView(order, u.role, u.id);
      if (!view) {
        if (s.rooms.has(orderRoom)) s.leave(orderRoom);
        continue;
      }
      s.emit('order_updated', view);
      if (opts.newOrderAlert && (u.role === 'ADMIN' || (u.role === 'VENDOR' && s.rooms.has(vendorRoom)))) s.emit('new_order_alert', view);
    }

    // Docs/22: a combined order is ONE pool entry (its primary child, see isPoolEligible) and only riders that sent `groups: 1`
    // are told about it: an old rider app would show it as a single restaurant and claim all of it blindly.
    const isGroup = !!order.groupId;
    const nowEligible = isPoolEligible(order);
    if (nowEligible) {
      const riders = await io.in('drivers').fetchSockets();
      // Offers go to approved riders who are ONLINE right now, whatever the room membership says.
      const ids = [...new Set(riders.map((s) => (s.data.user as SocketUser | undefined)?.id).filter((x): x is string => !!x))];
      const eligible = new Set(
        ids.length === 0 ? [] : (await prisma.driverPartner.findMany({ where: { userId: { in: ids }, approvalStatus: 'APPROVED', dutyStatus: 'ONLINE' }, select: { userId: true } })).map((d) => d.userId),
      );
      for (const s of riders) {
        const u = s.data.user as SocketUser | undefined;
        if (!u || !eligible.has(u.id)) continue;
        if (isGroup && !s.data.groups) continue;
        if (isGroup && opts.wasPoolEligible) continue; // Docs/22: a combined order is offered ONCE, when it becomes claimable
        const view = orderView(order, u.role, u.id);
        if (view) s.emit('order_available', view);
      }
    } else if (opts.wasPoolEligible) {
      if (isGroup) {
        for (const s of await io.in('drivers').fetchSockets()) if (s.data.groups) s.emit('order_unavailable', { id: order.id });
      } else {
        io.to('drivers').emit('order_unavailable', { id: order.id });
      }
    }
  } catch (err) {
    console.error('publishOrderChange failed:', errSummary(err));
  }
};

/**
 * Save a rider's position and forward it: `driver_location_update` to admins (dashboard map, only while on duty) and
 * `rider_location` to the room of each order the rider is actively carrying, but only to the owning
 * customer's sockets and admin sockets in that room.
 * Throws { status, code, message } for the REST endpoint.
 */
export const recordRiderLocation = async (riderUserId: string, lat: unknown, lng: unknown, heading: unknown) => {
  if (!isValidCoordinate(lat, lng)) {
    throw Object.assign(new Error('Latitude must be between -90 and 90 and longitude between -180 and 180.'), { status: 400, code: 'BAD_COORDINATES' });
  }
  const driver = await prisma.driverPartner.findUnique({ where: { userId: riderUserId }, include: { user: { select: { name: true } } } });
  if (!driver) throw Object.assign(new Error('A linked driver profile is required.'), { status: 400, code: 'RIDER_PROFILE_MISSING' });
  if (driver.approvalStatus !== 'APPROVED') throw Object.assign(new Error('Your account is not active.'), { status: 403, code: 'PARTNER_NOT_APPROVED' });
  const h = typeof heading === 'number' && Number.isFinite(heading) ? heading : 0;
  const name = driver.user?.name || driver.name;
  const loc = await prisma.driverLocation.upsert({
    where: { driverId: riderUserId },
    update: { lat: lat as number, lng: lng as number, heading: h, driverName: name, lastUpdated: new Date() },
    create: { driverId: riderUserId, driverName: name, lat: lat as number, lng: lng as number, heading: h },
  });

  const io = ioRef;
  if (io) {
    try {
      // Docs/19: admins only see a rider's position while the rider is on duty (ONLINE, or IN_TRANSIT with an order).
      // A fix that arrives after going OFFLINE is stored (above) but not broadcast to the dashboard.
      if (driver.dutyStatus !== 'OFFLINE') {
        io.to('admins').emit('driver_location_update', { ...loc, id: riderUserId, dutyStatus: driver.dutyStatus, approvalStatus: driver.approvalStatus });
      }
      const active = await prisma.order.findMany({
        where: { driverId: riderUserId, status: { in: [...ACTIVE_RIDER_STATUSES] } },
        select: { id: true, customerId: true },
      });
      for (const o of active) {
        const payload = { orderId: o.id, driverId: riderUserId, lat: loc.lat, lng: loc.lng, heading: loc.heading, at: loc.lastUpdated.toISOString() };
        const sockets = await io.in(`order_${o.id}`).fetchSockets();
        for (const s of sockets) {
          const u = s.data.user as SocketUser | undefined;
          if (u && (u.role === 'ADMIN' || (u.role === 'STUDENT' && u.id === o.customerId))) s.emit('rider_location', payload);
        }
      }
    } catch (err) {
      console.error('rider location fan-out failed:', errSummary(err));
    }
  }
  return loc;
};
