import { Router, Request, Response, NextFunction } from 'express';
import { ApprovalStatus, Role } from '@prisma/client';
import { prisma } from '../db';
import { generateToken, requireAuth, requireRole, AuthenticatedRequest, bumpTokenVersion, invalidateAuthCache } from '../middleware/auth';
import { canonicalPhone, last10 } from '../utils/phone';
import { hashPassword, passwordProblem } from '../services/password';
import { recordSuccess } from '../services/loginLimiter';
import { writeAudit as writeAuditLog } from '../services/audit';
import { dropFromPartnerRooms, addToPartnerRooms } from '../realtime';
import { errSummary } from '../utils/log';
import { clientIp } from '../middleware/rateLimit';
import { NAME_RE } from '../utils/names';
import { validParams } from '../utils/http';
import { disableUserTokens } from '../services/push/deviceTokens';
import { checkVendorLocation } from '../config/campus';
import { vendorLocationView, checkAccuracy, devicePinData, describePin } from '../services/vendorLocation';

/**
 * Partner (restaurant / rider) applications and the admin tools around them.
 * Flow: the partner creates an account in the app -> PENDING -> an admin approves or rejects in the
 * dashboard -> APPROVED partners can work. Rows created by an admin are APPROVED straight away.
 */
export const partnerRouter = Router();

const UPI_RE = /^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/;
const FSSAI_RE = /^\d{14}$/;
const VEHICLE_TYPES = ['Bike', 'Scooter', 'Cycle', 'On foot'];
const NO_PLATE_VEHICLES = new Set(['Cycle', 'On foot']);
export const DEFAULT_BANNER = 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600';

type Kind = 'VENDOR' | 'DRIVER';

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
const clean = (v: unknown, max = 200): string => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const blankToNull = (v: unknown, max = 200): string | null => {
  const s = clean(v, max);
  return s ? s : null;
};

const audit = writeAuditLog;

const notifyAdmins = (req: Request, event: string, payload: unknown) => {
  const io = req.app.get('io');
  if (io) io.to('admins').emit(event, payload);
};

/** Closes the live sockets of a user whose sessions were just revoked (they would otherwise keep receiving events). */
const io_disconnect = (req: Request, userId: string) => {
  try {
    req.app.get('io')?.in(`user_${userId}`).disconnectSockets(true);
  } catch (err) {
    console.error('disconnect sockets failed:', errSummary(err));
  }
};

const notApprovedMessage = (status: ApprovalStatus): string => {
  switch (status) {
    case 'PENDING': return 'Your account is waiting for Kraveo approval.';
    case 'REJECTED': return 'Your application was not approved.';
    case 'SUSPENDED': return 'Your account is suspended. Please contact Kraveo support.';
    default: return 'Your account is not active.';
  }
};

/**
 * Sign-up throttle (in memory, single PM2 instance like the login limiter). RULE: only a sign-up that is actually
 * being created counts. Validation failures never reach it (they are answered before), and a 409 "already registered"
 * or a failed insert gives its slot back, so a presenter who rehearses the demo sign-up several times, or who tries a
 * number that already exists, is never locked out. Limits on slots in use per hour:
 *   - 3 per phone number   (a number that keeps being re-created, e.g. delete-and-sign-up loops),
 *   - 10 per client IP     (one campus NAT may legitimately onboard a few partners; a script cannot spam from one address),
 *   - 80 overall           (a backstop against a distributed flood filling the approval queue).
 * Request VOLUME per IP (including the cheap 400/409 answers) is capped separately by AUTH_IP in middleware/rateLimit.ts.
 */
const signupByPhone = new Map<string, number[]>();
const signupByIp = new Map<string, number[]>();
let signupAll: number[] = [];
const HOUR = 60 * 60 * 1000;
const SIGNUP_LIMITS = { phone: 3, ip: 10, all: 80 };
export const __resetSignupLimiter = () => { signupByPhone.clear(); signupByIp.clear(); signupAll = []; };
const recent = (list: number[] | undefined, now: number) => (list ?? []).filter((t) => now - t < HOUR);
/** Takes a slot (returns a function that gives it back), or null when a limit is reached. */
const reserveSignup = (phoneKey: string, ip: string, now = Date.now()): (() => void) | null => {
  signupAll = recent(signupAll, now);
  const byPhone = recent(signupByPhone.get(phoneKey), now);
  const byIp = recent(signupByIp.get(ip), now);
  if (signupAll.length >= SIGNUP_LIMITS.all || byPhone.length >= SIGNUP_LIMITS.phone || byIp.length >= SIGNUP_LIMITS.ip) return null;
  signupAll.push(now); byPhone.push(now); byIp.push(now);
  signupByPhone.set(phoneKey, byPhone); signupByIp.set(ip, byIp);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const drop = (list: number[] | undefined) => { const i = list ? list.indexOf(now) : -1; if (list && i >= 0) list.splice(i, 1); };
    drop(signupAll); drop(signupByPhone.get(phoneKey)); drop(signupByIp.get(ip));
  };
};

const newRunnerCode = async (): Promise<string> => {
  for (let i = 0; i < 12; i += 1) {
    const code = `RUN-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!(await prisma.driverPartner.findUnique({ where: { runnerCode: code }, select: { id: true } }))) return code;
  }
  return `RUN-${Date.now().toString().slice(-6)}`;
};

type Fail = { field: string; message: string };

/** Validates the restaurant fields shared by sign-up, re-apply and admin creation. */
const vendorFields = (b: any): { ok: true; data: { name: string; category: string; address: string; fssaiNumber: string | null } } | { ok: false; error: Fail } => {
  const name = clean(b?.restaurantName ?? b?.vendorName, 60);
  if (name.length < 2) return { ok: false, error: { field: 'restaurantName', message: 'Enter the restaurant name.' } };
  const category = clean(b?.category, 60) || 'Campus kitchen';
  const address = clean(b?.address, 140);
  if (address.length < 3) return { ok: false, error: { field: 'address', message: 'Tell us where the kitchen is.' } };
  const fssai = clean(b?.fssaiNumber, 20).replace(/\s/g, '');
  if (fssai && !FSSAI_RE.test(fssai)) return { ok: false, error: { field: 'fssaiNumber', message: 'FSSAI number has 14 digits. Leave it empty if you do not have it yet.' } };
  return { ok: true, data: { name, category, address, fssaiNumber: fssai || null } };
};

/** Validates the rider fields shared by sign-up, re-apply and admin creation. */
const driverFields = (b: any, ownPhone: string, requirePlate = true): { ok: true; data: { vehicleType: string; vehicleRegNo: string | null; emergencyPhone: string | null; upiId: string | null } } | { ok: false; error: Fail } => {
  const vehicleType = VEHICLE_TYPES.find((v) => v.toLowerCase() === clean(b?.vehicleType, 20).toLowerCase());
  if (!vehicleType) return { ok: false, error: { field: 'vehicleType', message: 'Choose Bike, Scooter, Cycle or On foot.' } };
  const plate = clean(b?.vehicleRegNo, 16).toUpperCase();
  if (requirePlate && !NO_PLATE_VEHICLES.has(vehicleType) && plate.length < 4) return { ok: false, error: { field: 'vehicleRegNo', message: 'Enter the vehicle number plate.' } };
  let emergencyPhone: string | null = null;
  if (clean(b?.emergencyPhone, 20)) {
    emergencyPhone = canonicalPhone(b.emergencyPhone);
    if (!emergencyPhone) return { ok: false, error: { field: 'emergencyPhone', message: 'Enter a valid 10-digit emergency contact number.' } };
    if (last10(emergencyPhone) === last10(ownPhone)) return { ok: false, error: { field: 'emergencyPhone', message: 'The emergency contact must be someone else.' } };
  }
  const upi = clean(b?.upiId, 60);
  if (upi && !UPI_RE.test(upi)) return { ok: false, error: { field: 'upiId', message: 'That UPI id does not look right (example: name@upi).' } };
  return { ok: true, data: { vehicleType, vehicleRegNo: plate || null, emergencyPhone, upiId: upi || null } };
};

/**
 * Optional restaurant pin sent with sign-up (Docs/20): `lat` + `lng` (both or neither, JSON numbers, within 3 km of the campus)
 * and an optional `locationAccuracyM` (0..5000). null/absent = no location, exactly as before. An accuracy without coordinates is ignored.
 */
const signupLocation = (b: any): { ok: true; pin: { lat: number; lng: number; accuracyM: number | null } | null } | { ok: false; error: Fail } => {
  const has = (v: unknown) => v !== undefined && v !== null;
  if (!has(b?.lat) && !has(b?.lng)) return { ok: true, pin: null };
  if (!has(b.lat)) return { ok: false, error: { field: 'lat', message: 'Send both latitude and longitude, or neither.' } };
  if (!has(b.lng)) return { ok: false, error: { field: 'lng', message: 'Send both latitude and longitude, or neither.' } };
  const check = checkVendorLocation(b.lat, b.lng);
  if (!check.ok) return { ok: false, error: { field: check.field, message: check.message } };
  const acc = checkAccuracy(b.locationAccuracyM);
  if (!acc.ok) return { ok: false, error: { field: 'locationAccuracyM', message: acc.message } };
  return { ok: true, pin: { lat: check.lat, lng: check.lng, accuracyM: acc.value } };
};

export { vendorFields as validateVendorFields, driverFields as validateDriverFields, newRunnerCode, audit as writeAudit, clean, blankToNull };

// ----------------------------------------------------------------------------
// Gate for everything a partner does in the field. Admins and students pass through untouched.
// A partner profile that exists but is not APPROVED is blocked; users with no profile row keep the old behaviour.
// ----------------------------------------------------------------------------
export const requireApprovedPartner = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const user = req.user;
    if (!user || (user.role !== Role.VENDOR && user.role !== Role.DRIVER)) return next();
    let statuses: ApprovalStatus[] = [];
    if (user.role === Role.VENDOR) {
      statuses = (await prisma.vendor.findMany({ where: { userId: user.id }, select: { approvalStatus: true } })).map((v) => v.approvalStatus);
    } else {
      const d = await prisma.driverPartner.findUnique({ where: { userId: user.id }, select: { approvalStatus: true } });
      statuses = d ? [d.approvalStatus] : [];
    }
    if (statuses.length === 0 || statuses.includes('APPROVED')) return next();
    const blocking = statuses.includes('PENDING') ? 'PENDING' : statuses[0];
    return res.status(403).json({ success: false, code: 'PARTNER_NOT_APPROVED', approvalStatus: blocking, message: notApprovedMessage(blocking) });
  } catch (err) {
    console.error('requireApprovedPartner failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
};

const vendorView = (v: any) => v && ({
  id: v.id, name: v.name, category: v.category, address: v.address, fssaiNumber: v.fssaiNumber ?? null,
  isAcceptingOrders: v.isAcceptingOrders, approvalStatus: v.approvalStatus, rejectionReason: v.rejectionReason ?? null,
  ...vendorLocationView(v),
});
const driverView = (d: any) => d && ({
  id: d.id, runnerCode: d.runnerCode, vehicleType: d.vehicleType, vehicleRegNo: d.vehicleRegNo ?? null,
  emergencyPhone: d.emergencyPhone ?? null, upiId: d.upiId ?? null, approvalStatus: d.approvalStatus, rejectionReason: d.rejectionReason ?? null,
  dutyStatus: d.dutyStatus ?? 'OFFLINE', // lets the rider app re-read what the server believes (second phone, bad network, logout elsewhere)
});

// ----------------------------------------------------------------------------
// Partner side
// ----------------------------------------------------------------------------

// Create a partner account. It starts PENDING; the app signs the person in so it can show the waiting screen.
partnerRouter.post('/auth/partner-signup', async (req: Request, res: Response) => {
  let releaseSlot: (() => void) | null = null; // gives the throttle slot back when no account ends up being created
  try {
    const b = req.body ?? {};
    const role = String(b.role || '').toUpperCase();
    const bad = (e: Fail) => res.status(400).json({ success: false, field: e.field, message: e.message });
    if (role !== 'VENDOR' && role !== 'DRIVER') return bad({ field: 'role', message: 'Role must be VENDOR or DRIVER.' });

    const name = clean(b.name, 60);
    if (!NAME_RE.test(name)) return bad({ field: 'name', message: 'Enter your full name.' });
    const phone = canonicalPhone(b.phone);
    if (!phone) return bad({ field: 'phone', message: 'Enter a valid 10-digit mobile number.' });
    const problem = passwordProblem(b.password);
    if (problem) return bad({ field: 'password', message: problem });

    const details = role === 'VENDOR' ? vendorFields(b) : driverFields(b, phone);
    if (!details.ok) return bad(details.error);
    const location = role === 'VENDOR' ? signupLocation(b) : ({ ok: true, pin: null } as const);
    if (!location.ok) return bad(location.error);

    releaseSlot = reserveSignup(last10(phone), clientIp(req));
    if (!releaseSlot) {
      return res.status(429).json({ success: false, message: 'Too many sign-up attempts. Please try again in an hour.' });
    }
    if (await prisma.user.findFirst({ where: { phone: { endsWith: last10(phone) } }, select: { id: true } })) {
      releaseSlot(); // an "already registered" answer is not a sign-up: it must not count against the visitor
      return res.status(409).json({ success: false, field: 'phone', message: 'This phone number already has an account. Try logging in.' });
    }

    const passwordHash = await hashPassword(b.password);
    const now = new Date();
    const runnerCode = role === 'DRIVER' ? await newRunnerCode() : '';
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { name, phone, role: role as Role, passwordHash } });
      if (role === 'VENDOR') {
        const d = (details as any).data;
        const vendor = await tx.vendor.create({
          data: { userId: user.id, name: d.name, category: d.category, address: d.address, fssaiNumber: d.fssaiNumber, bannerImage: DEFAULT_BANNER, isAcceptingOrders: false, approvalStatus: 'PENDING', appliedAt: now, ...(location.pin ? devicePinData(location.pin.lat, location.pin.lng, location.pin.accuracyM) : {}) },
        });
        return { user, vendor, driver: null };
      }
      const d = (details as any).data;
      const driver = await tx.driverPartner.create({
        data: { userId: user.id, name, phone, runnerCode, vehicleType: d.vehicleType, vehicleRegNo: d.vehicleRegNo, emergencyPhone: d.emergencyPhone, upiId: d.upiId, approvalStatus: 'PENDING', appliedAt: now },
      });
      return { user, vendor: null, driver };
    });

    releaseSlot = null; // the account exists: the slot stays used
    notifyAdmins(req, 'partner_application', {
      kind: role, id: (created.vendor ?? created.driver)!.id, name: created.user.name, phone: created.user.phone, appliedAt: now.toISOString(),
    });

    const token = generateToken({ id: created.user.id, phone: created.user.phone, role: created.user.role, tokenVersion: created.user.tokenVersion });
    return res.status(201).json({
      success: true,
      token,
      approvalStatus: 'PENDING',
      user: { id: created.user.id, name: created.user.name, phone: created.user.phone, role: created.user.role, avatarId: null },
      ...(created.vendor ? { vendor: vendorView(created.vendor) } : {}),
      ...(created.driver ? { driver: driverView(created.driver) } : {}),
    });
  } catch (err) {
    releaseSlot?.(); // a failed insert (for example a lost race on the unique phone) is not a sign-up either
    if ((err as any)?.code === 'P2002') {
      // Two sign-ups with the same phone at the same moment: the other one won. Same answer as the duplicate check above.
      return res.status(409).json({ success: false, field: 'phone', message: 'This phone number already has an account. Try logging in.' });
    }
    console.error('partner-signup failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

const loadOwnProfile = async (userId: string, role: Role) => {
  if (role === Role.VENDOR) {
    const vendors = await prisma.vendor.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    // Prefer an APPROVED restaurant, otherwise whatever was applied for.
    const vendor = vendors.find((v) => v.approvalStatus === 'APPROVED') ?? vendors[0] ?? null;
    return { vendor, driver: null as any, status: (vendor?.approvalStatus ?? 'APPROVED') as ApprovalStatus, reason: vendor?.rejectionReason ?? null };
  }
  const driver = await prisma.driverPartner.findUnique({ where: { userId } });
  return { vendor: null as any, driver, status: (driver?.approvalStatus ?? 'APPROVED') as ApprovalStatus, reason: driver?.rejectionReason ?? null };
};

// "Where do I stand?" - the apps poll this while the application is pending.
partnerRouter.get('/partner/me', requireAuth, requireRole('VENDOR', 'DRIVER'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(401).json({ success: false, message: 'Account not found.' });
    const p = await loadOwnProfile(user.id, user.role);
    return res.json({
      success: true,
      user: { id: user.id, name: user.name, phone: user.phone, role: user.role, avatarId: user.avatarId ?? null },
      approvalStatus: p.status,
      rejectionReason: p.reason,
      ...(p.vendor ? { vendor: vendorView(p.vendor) } : {}),
      ...(p.driver ? { driver: driverView(p.driver) } : {}),
    });
  } catch (err) {
    console.error('partner/me failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// The restaurant sets its own map pin from the phone's GPS (Docs/20). Own vendor row only (never an id from the body).
// Allowed while the application is PENDING (the pin is part of what the admin reviews) and APPROVED; REJECTED / SUSPENDED
// get the same 403 PARTNER_NOT_APPROVED as the other partner writes. Rate limited in middleware/rateLimit.ts (VENDOR_LOCATION).
partnerRouter.put('/partner/vendor/location', requireAuth, requireRole('VENDOR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const bad = (e: Fail) => res.status(400).json({ success: false, field: e.field, message: e.message });
    const { vendor } = await loadOwnProfile(req.user!.id, Role.VENDOR);
    if (!vendor) return res.status(404).json({ success: false, message: 'No restaurant is linked to this account.' });
    if (vendor.approvalStatus !== 'PENDING' && vendor.approvalStatus !== 'APPROVED') {
      return res.status(403).json({ success: false, code: 'PARTNER_NOT_APPROVED', approvalStatus: vendor.approvalStatus, message: notApprovedMessage(vendor.approvalStatus) });
    }
    const check = checkVendorLocation(b.lat, b.lng);
    if (!check.ok) return bad({ field: check.field, message: check.message });
    const acc = checkAccuracy(b.accuracyM);
    if (!acc.ok) return bad({ field: 'accuracyM', message: acc.message });

    const updated = await prisma.vendor.update({ where: { id: vendor.id }, data: devicePinData(check.lat, check.lng, acc.value) });
    await audit(
      'VENDOR_LOCATION_SET', 'VENDOR', vendor.id,
      `${vendor.name} set its own map location from the phone to ${check.lat.toFixed(6)}, ${check.lng.toFixed(6)}${acc.value !== null ? ` (about ${Math.round(acc.value)} m)` : ''}; previous: ${describePin(vendor)}`,
    );
    const { hasLocation, lat, lng, locationSource, locationSetAt, locationAccuracyM } = vendorLocationView(updated);
    return res.json({ success: true, data: { lat, lng, hasLocation, locationSource, locationSetAt, locationAccuracyM } });
  } catch (err) {
    console.error('partner/vendor/location failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Could not save the location. Please try again.' });
  }
});

// Rider goes on / off duty. The dashboard's "online" counts and the dispatch list read this.
// A rider who is mid-delivery shows as IN_TRANSIT, never plain ONLINE.
partnerRouter.post('/drivers/duty-status', requireAuth, requireRole('DRIVER'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (typeof req.body?.isOnline !== 'boolean') return res.status(400).json({ success: false, field: 'isOnline', message: 'isOnline (true or false) is required.' });
    const driver = await prisma.driverPartner.findUnique({ where: { userId: req.user!.id } });
    if (!driver) return res.status(404).json({ success: false, message: 'No rider profile is linked to this account.' });
    const active = await prisma.order.count({ where: { driverId: req.user!.id, status: { in: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'ARRIVED_AT_GATE'] } } });
    const dutyStatus = !req.body.isOnline ? 'OFFLINE' : active > 0 ? 'IN_TRANSIT' : 'ONLINE';
    const updated = await prisma.driverPartner.update({ where: { id: driver.id }, data: { dutyStatus } });
    // Offers (`order_available`) only reach riders on duty: leave the room when going off duty, join when going on.
    if (dutyStatus === 'OFFLINE') await dropFromPartnerRooms(req.user!.id, ['drivers']);
    else addToPartnerRooms(req.user!.id, ['drivers']);
    notifyAdmins(req, 'driver_duty_update', { id: updated.id, userId: updated.userId, dutyStatus });
    return res.json({ success: true, dutyStatus });
  } catch (err) {
    console.error('duty-status failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Could not update duty status.' });
  }
});

// Fix and re-send the application (allowed while PENDING, or after a REJECTED decision).
partnerRouter.put('/partner/application', requireAuth, requireRole('VENDOR', 'DRIVER'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = req.body ?? {};
    const bad = (e: Fail) => res.status(400).json({ success: false, field: e.field, message: e.message });
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(401).json({ success: false, message: 'Account not found.' });
    const p = await loadOwnProfile(user.id, user.role);
    if (p.status !== 'PENDING' && p.status !== 'REJECTED') {
      return res.status(409).json({ success: false, message: p.status === 'APPROVED' ? 'Your account is already approved.' : notApprovedMessage(p.status) });
    }
    if (clean(b.name, 60)) {
      const name = clean(b.name, 60);
      if (!NAME_RE.test(name)) return bad({ field: 'name', message: 'Enter your full name.' });
      await prisma.user.update({ where: { id: user.id }, data: { name } });
    }
    const now = new Date();
    if (user.role === Role.VENDOR) {
      if (!p.vendor) return res.status(404).json({ success: false, message: 'No restaurant is linked to this account.' });
      const v = vendorFields({ restaurantName: p.vendor.name, category: p.vendor.category, address: p.vendor.address, fssaiNumber: p.vendor.fssaiNumber, ...b });
      if (!v.ok) return bad(v.error);
      await prisma.vendor.update({ where: { id: p.vendor.id }, data: { ...v.data, approvalStatus: 'PENDING', rejectionReason: null, appliedAt: now, reviewedAt: null } });
    } else {
      if (!p.driver) return res.status(404).json({ success: false, message: 'No rider profile is linked to this account.' });
      const d = driverFields({ vehicleType: p.driver.vehicleType, vehicleRegNo: p.driver.vehicleRegNo, emergencyPhone: p.driver.emergencyPhone, upiId: p.driver.upiId, ...b }, user.phone ?? '');
      if (!d.ok) return bad(d.error);
      await prisma.driverPartner.update({ where: { id: p.driver.id }, data: { ...d.data, ...(clean(b.name, 60) ? { name: clean(b.name, 60) } : {}), approvalStatus: 'PENDING', rejectionReason: null, appliedAt: now, reviewedAt: null } });
    }
    const fresh = await loadOwnProfile(user.id, user.role);
    notifyAdmins(req, 'partner_application', { kind: user.role, id: (fresh.vendor ?? fresh.driver).id, name: user.name, phone: user.phone, appliedAt: now.toISOString(), resubmitted: true });
    // Same `user` object as /partner/me and sign-in: the apps parse this answer as a session (re-read name: it may have just changed).
    const freshUser = (await prisma.user.findUnique({ where: { id: user.id } })) ?? user;
    return res.json({
      success: true,
      user: { id: freshUser.id, name: freshUser.name, phone: freshUser.phone, role: freshUser.role, avatarId: freshUser.avatarId ?? null },
      approvalStatus: fresh.status,
      rejectionReason: fresh.reason,
      ...(fresh.vendor ? { vendor: vendorView(fresh.vendor) } : {}),
      ...(fresh.driver ? { driver: driverView(fresh.driver) } : {}),
    });
  } catch (err) {
    console.error('partner/application failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// ----------------------------------------------------------------------------
// Admin: applications and partner status
// ----------------------------------------------------------------------------
const applicationRow = (kind: Kind, row: any) => ({
  id: row.id,
  kind,
  userId: row.userId ?? row.user?.id ?? null,
  name: kind === 'VENDOR' ? (row.user?.name ?? row.name) : row.name,
  phone: row.user?.phone ?? row.phone ?? null,
  status: row.approvalStatus as ApprovalStatus,
  rejectionReason: row.rejectionReason ?? null,
  selfSignup: !!row.appliedAt,
  appliedAt: row.appliedAt ?? row.createdAt,
  reviewedAt: row.reviewedAt ?? null,
  createdAt: row.createdAt,
  ...(kind === 'VENDOR'
    ? { vendor: { name: row.name, category: row.category, address: row.address, fssaiNumber: row.fssaiNumber ?? null, isAcceptingOrders: row.isAcceptingOrders, ...vendorLocationView(row) } }
    : { driver: { runnerCode: row.runnerCode, vehicleType: row.vehicleType, vehicleRegNo: row.vehicleRegNo ?? null, emergencyPhone: row.emergencyPhone ?? null, upiId: row.upiId ?? null } }),
});

partnerRouter.get('/admin/applications', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const wanted = String(req.query.status ?? 'PENDING').toUpperCase();
    const kindFilter = String(req.query.kind ?? '').toUpperCase();
    const statusWhere = wanted === 'ALL' ? {} : (['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'].includes(wanted) ? { approvalStatus: wanted as ApprovalStatus } : { approvalStatus: 'PENDING' as ApprovalStatus });
    const [vendors, drivers, vc, dc] = await Promise.all([
      kindFilter === 'DRIVER' ? [] : prisma.vendor.findMany({ where: { ...statusWhere, userId: { not: null } }, include: { user: { select: { id: true, name: true, phone: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }),
      kindFilter === 'VENDOR' ? [] : prisma.driverPartner.findMany({ where: statusWhere, include: { user: { select: { id: true, name: true, phone: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.vendor.groupBy({ by: ['approvalStatus'], _count: true, where: { userId: { not: null } } }),
      prisma.driverPartner.groupBy({ by: ['approvalStatus'], _count: true }),
    ]);
    const counts: Record<string, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, SUSPENDED: 0 };
    for (const g of [...vc, ...dc]) counts[g.approvalStatus] += g._count;
    const data = [...vendors.map((v) => applicationRow('VENDOR', v)), ...drivers.map((d) => applicationRow('DRIVER', d))]
      .sort((a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime());
    return res.json({ success: true, counts, count: data.length, data });
  } catch (err: any) {
    console.error('admin/applications failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Could not load applications.' });
  }
});

// APPROVED / REJECTED / SUSPENDED for a vendor or rider profile.
partnerRouter.post('/admin/partners/:kind/:id/status', requireAuth, requireRole('ADMIN'), validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const kind = String(req.params.kind).toUpperCase() as Kind;
    const next = String(req.body?.status ?? '').toUpperCase() as ApprovalStatus;
    const reason = clean(req.body?.reason, 200);
    if (kind !== 'VENDOR' && kind !== 'DRIVER') return res.status(400).json({ success: false, message: 'Kind must be vendor or driver.' });
    if (!['APPROVED', 'REJECTED', 'SUSPENDED'].includes(next)) return res.status(400).json({ success: false, message: 'Status must be APPROVED, REJECTED or SUSPENDED.' });
    if ((next === 'REJECTED' || next === 'SUSPENDED') && reason.length < 3) return res.status(400).json({ success: false, field: 'reason', message: 'Please give a short reason (the partner will see it).' });

    const row: any = kind === 'VENDOR'
      ? await prisma.vendor.findUnique({ where: { id: req.params.id }, include: { user: true } })
      : await prisma.driverPartner.findUnique({ where: { id: req.params.id }, include: { user: true } });
    if (!row) return res.status(404).json({ success: false, message: 'Partner not found.' });

    const from = row.approvalStatus as ApprovalStatus;
    if (from === next) return res.status(409).json({ success: false, message: `Already ${next.toLowerCase()}.` });
    if (next === 'REJECTED' && from !== 'PENDING') return res.status(409).json({ success: false, message: 'Only a pending application can be rejected. Suspend an active partner instead.' });
    if (next === 'SUSPENDED' && from !== 'APPROVED') return res.status(409).json({ success: false, message: 'Only an approved partner can be suspended.' });

    const data: any = { approvalStatus: next, reviewedAt: new Date(), rejectionReason: next === 'APPROVED' ? null : reason };
    if (next === 'SUSPENDED') {
      if (kind === 'VENDOR') data.isAcceptingOrders = false;
      else data.dutyStatus = 'OFFLINE';
    }
    const updated: any = kind === 'VENDOR'
      ? await prisma.vendor.update({ where: { id: row.id }, data, include: { user: { select: { id: true, name: true, phone: true } } } })
      : await prisma.driverPartner.update({ where: { id: row.id }, data, include: { user: { select: { id: true, name: true, phone: true } } } });

    const label = `${kind.toLowerCase()} ${row.name} (${row.user?.phone ?? 'no phone'})`;
    await audit(`PARTNER_${next}`, kind, row.id, `${next} ${label} from ${from}${reason ? `: ${reason}` : ''}`);
    // Rejected / suspended partners get no pushes (new orders, deliveries) on any device; the recipient lookup also checks approval.
    if (next !== 'APPROVED' && row.userId) await disableUserTokens(row.userId, `PARTNER_${next}`);
    // A suspended rider must stop hearing about new orders at once (not only after a reconnect).
    if (next !== 'APPROVED' && kind === 'DRIVER' && row.userId) await dropFromPartnerRooms(row.userId, ['drivers']);
    if (next !== 'APPROVED' && kind === 'VENDOR' && row.userId) await dropFromPartnerRooms(row.userId, [`vendor_${row.id}`]);
    // A suspended partner's old sessions end now (they sign in again and get the "suspended" answer). Rejection of a
    // pending application changes nothing for a signed-in applicant: they keep their session to see the reason / re-apply.
    if (next === 'SUSPENDED' && row.userId) {
      await bumpTokenVersion(row.userId);
      io_disconnect(req, row.userId);
    }
    notifyAdmins(req, 'partner_application_updated', { kind, id: row.id, status: next });
    return res.json({ success: true, data: applicationRow(kind, updated) });
  } catch (err) {
    console.error('partner status failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Could not update the partner.' });
  }
});

// There is no self-service "forgot password" (no SMS), so an admin sets a new one.
partnerRouter.post('/admin/partners/:userId/reset-password', requireAuth, requireRole('ADMIN'), validParams('userId'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const problem = passwordProblem(req.body?.password);
    if (problem) return res.status(400).json({ success: false, field: 'password', message: problem });
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user || (user.role !== Role.VENDOR && user.role !== Role.DRIVER)) return res.status(404).json({ success: false, message: 'Partner account not found.' });
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(req.body.password), tokenVersion: { increment: 1 } } });
    invalidateAuthCache(user.id); // every session of this partner ends: the old password's tokens are dead
    io_disconnect(req, user.id);
    if (user.phone) recordSuccess(last10(user.phone));
    await audit('PASSWORD_RESET', user.role, user.id, `Reset the password of ${user.role.toLowerCase()} ${user.name} (${user.phone ?? 'no phone'})`);
    return res.json({ success: true });
  } catch (err) {
    console.error('reset-password failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Could not reset the password.' });
  }
});

partnerRouter.get('/admin/audit-log', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const data = await prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, message: 'Could not load the activity log.' });
  }
});

// ----------------------------------------------------------------------------
// Admin: customers (full detail)
// ----------------------------------------------------------------------------
const customerBase = (u: any) => ({
  id: u.id,
  name: u.name,
  email: u.email ?? null,
  phone: u.phone ?? null,
  isStudent: u.isStudent ?? null,
  hostelBlock: u.hostelBlock ?? null,
  avatarId: u.avatarId ?? null,
  kraveoCoins: u.kraveoCoins,
  createdAt: u.createdAt,
  deleted: !u.email && !u.googleSub && !u.phone && u.name === 'Deleted user',
});

partnerRouter.get('/admin/customers', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const search = clean(req.query.search, 60);
    const requested = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 50, 100);
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined;
    const where: any = { role: Role.STUDENT };
    // Accounts the customer deleted are anonymised ("Deleted user", no email/phone); they are noise in the list.
    if (req.query.includeDeleted !== '1') where.NOT = { name: 'Deleted user', email: null, googleSub: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search.replace(/\s/g, '') } },
        { hostelBlock: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [page, total] = await Promise.all([
      prisma.user.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
      prisma.user.count({ where }),
    ]);
    const hasMore = page.length > limit;
    const users = hasMore ? page.slice(0, limit) : page;
    const stats = users.length
      ? await prisma.order.groupBy({ by: ['customerId'], where: { customerId: { in: users.map((u) => u.id) } }, _count: { _all: true }, _sum: { totalAmount: true }, _max: { createdAt: true } })
      : [];
    const paid = users.length
      ? await prisma.order.groupBy({ by: ['customerId'], where: { customerId: { in: users.map((u) => u.id) }, paymentStatus: 'PAID' }, _sum: { totalAmount: true } })
      : [];
    const byId = new Map(stats.map((s) => [s.customerId, s]));
    const paidById = new Map(paid.map((s) => [s.customerId, s._sum.totalAmount ?? 0]));
    return res.json({
      success: true,
      total,
      nextCursor: hasMore ? users[users.length - 1].id : null,
      data: users.map((u) => ({
        ...customerBase(u),
        ordersCount: byId.get(u.id)?._count._all ?? 0,
        totalSpent: paidById.get(u.id) ?? 0,
        lastOrderAt: byId.get(u.id)?._max.createdAt ?? null,
      })),
    });
  } catch (err) {
    console.error('admin/customers failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Could not load customers.' });
  }
});

partnerRouter.get('/admin/customers/:id', requireAuth, requireRole('ADMIN'), validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findFirst({ where: { id: req.params.id, role: Role.STUDENT } });
    if (!user) return res.status(404).json({ success: false, message: 'Customer not found.' });
    const [orders, grouped, paidSum] = await Promise.all([
      prisma.order.findMany({
        where: { customerId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: { items: true, vendor: { select: { id: true, name: true } }, driver: { select: { id: true, name: true, phone: true } }, payments: true },
      }),
      prisma.order.groupBy({ by: ['status'], where: { customerId: user.id }, _count: { _all: true } }),
      prisma.order.aggregate({ where: { customerId: user.id, paymentStatus: 'PAID' }, _sum: { totalAmount: true }, _count: { _all: true } }),
    ]);
    const byStatus: Record<string, number> = {};
    for (const g of grouped) byStatus[g.status] = g._count._all;
    const ordersCount = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const first = await prisma.order.findFirst({ where: { customerId: user.id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    return res.json({
      success: true,
      data: {
        ...customerBase(user),
        stats: {
          ordersCount,
          deliveredCount: byStatus.DELIVERED ?? 0,
          cancelledCount: byStatus.CANCELLED ?? 0,
          activeCount: ordersCount - (byStatus.DELIVERED ?? 0) - (byStatus.CANCELLED ?? 0),
          paidOrdersCount: paidSum._count._all,
          totalSpent: paidSum._sum.totalAmount ?? 0,
          firstOrderAt: first?.createdAt ?? null,
          lastOrderAt: orders[0]?.createdAt ?? null,
        },
        orders: orders.map((o) => ({
          id: o.id,
          status: o.status,
          paymentStatus: o.paymentStatus,
          totalAmount: o.totalAmount,
          deliveryFee: o.deliveryFee,
          dropoffHostel: o.dropoffHostel,
          dropoffNotes: o.dropoffNotes,
          createdAt: o.createdAt,
          vendor: o.vendor,
          driver: o.driver,
          items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
          payments: o.payments.map((p) => ({ id: p.id, razorpayPaymentId: p.razorpayPaymentId, amount: p.amount, status: p.status, createdAt: p.createdAt })),
        })),
      },
    });
  } catch (err) {
    console.error('admin/customers/:id failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Could not load the customer.' });
  }
});
