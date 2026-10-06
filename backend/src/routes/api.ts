import { Router, Request, Response } from 'express';
import { Role } from '@prisma/client';
import { generateToken, requireAuth, requireRole, AuthenticatedRequest, verifyTokenForAccount, invalidateAuthCache } from '../middleware/auth';
import { prisma } from '../db';
import { canonicalPhone, last10 } from '../utils/phone';
import { hashPassword, verifyPassword, getDummyHash, passwordProblem } from '../services/password';
import { isLocked, recordFailure, recordSuccess, ipLockedFor, recordIpFailure } from '../services/loginLimiter';
import { rateLimitMiddleware, FailureLimiter, clientIp } from '../middleware/rateLimit';
import { DROP_POINTS, CAMPUS_CENTER, normalizeDropPoint, checkVendorLocation, vendorHasLocation } from '../config/campus';
import { fail, validParams, ID_RE } from '../utils/http';
import { errSummary } from '../utils/log';
import { NAME_RE } from '../utils/names';
import { startOfIstDay, istHour } from '../utils/time';
import { dropFromPartnerRooms } from '../realtime';
import { publicVendorView, publicMenuItem, validateMenuItemFields, priceProblem } from '../utils/catalog';
import { verifyGoogleIdToken, GoogleAuthError } from '../services/googleAuth';
import { timingSafeEqual } from 'crypto';
import { orderRouter } from './orders';
import { deviceRouter } from './devices';
import { disableUserTokens } from '../services/push/deviceTokens';
import { adminPinData, vendorLocationView, describePin, VENDOR_LOCATION_SELECT } from '../services/vendorLocation';
import { partnerRouter, requireApprovedPartner, validateVendorFields, validateDriverFields, newRunnerCode, writeAudit, DEFAULT_BANNER } from './partners';

export const apiRouter = Router();

// Rate limits are mounted by path, before any handler (see middleware/rateLimit.ts for the numbers).
apiRouter.use(rateLimitMiddleware);
// Partner sign-up, applications, approval and admin customer views live in ./partners.
apiRouter.use(partnerRouter);
// Orders, payments, rider pool, gate OTP and the admin order tools live in ./orders.
apiRouter.use(orderRouter);
// Push device tokens (POST/DELETE /api/devices).
apiRouter.use(deviceRouter);

// Admin passcode: only WRONG passcodes count, per client IP (nginx sets X-Forwarded-For, `trust proxy` = 1).
const adminLoginFailures = new FailureLimiter({ maxFails: 5, windowMs: 15 * 60 * 1000 });
export const __resetAdminLoginLimiter = () => adminLoginFailures.reset();
const canManageVendor = async (vendorId: string, user: AuthenticatedRequest['user']) => {
  if (user?.role === Role.ADMIN) return true;
  if (user?.role !== Role.VENDOR) return false;
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
  return vendor?.userId === user.id;
};

/** Public catalogue routes do not require a login, but admins and the owning vendor may still see unapproved restaurants. */
const optionalViewer = async (req: Request): Promise<{ id: string; role: Role } | null> => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    const decoded = await verifyTokenForAccount(header.split(' ')[1]);
    return { id: decoded.id, role: decoded.role as Role };
  } catch {
    return null;
  }
};
const canSeeVendor = (vendor: { approvalStatus: string; userId: string | null }, viewer: { id: string; role: Role } | null) =>
  vendor.approvalStatus === 'APPROVED' || viewer?.role === Role.ADMIN || (!!viewer && viewer.role === Role.VENDOR && vendor.userId === viewer.id);

// ----------------------------------------------------
// DRIVER PARTNER MANAGEMENT ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/drivers', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const drivers = await prisma.driverPartner.findMany({
      include: { user: { select: { id: true, name: true, phone: true, role: true, avatarId: true, createdAt: true } } }
    });
    return res.json({ success: true, count: drivers.length, data: drivers });
  } catch (err: any) {
    return fail(res, err, 'Error fetching drivers');
  }
});

apiRouter.get('/drivers/locations', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dbLocs = await prisma.driverLocation.findMany({
      where: req.user?.role === Role.ADMIN ? undefined : { driverId: req.user?.id }
    });
    // Docs/19: duty and approval status ride along so the dashboard can colour offline riders without a second call.
    const profiles = dbLocs.length === 0 ? [] : await prisma.driverPartner.findMany({
      where: { userId: { in: dbLocs.map((l) => l.driverId) } },
      select: { userId: true, dutyStatus: true, approvalStatus: true },
    });
    const byUser = new Map(profiles.map((p) => [p.userId, p] as const));
    const data = dbLocs.map((l) => ({
      ...l,
      dutyStatus: byUser.get(l.driverId)?.dutyStatus ?? 'OFFLINE',
      approvalStatus: byUser.get(l.driverId)?.approvalStatus ?? null,
    }));
    return res.json({ success: true, data });
  } catch (err: any) {
    return fail(res, err, 'Error fetching driver locations');
  }
});

// Campus drop points and map centre (Docs/19). Static, so clients may cache it for a few minutes.
apiRouter.get('/campus', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
  res.set('Cache-Control', 'private, max-age=300');
  return res.json({
    success: true,
    data: {
      center: { lat: CAMPUS_CENTER.lat, lng: CAMPUS_CENTER.lng },
      dropPoints: DROP_POINTS.map((p) => ({ id: p.id, name: p.name, group: p.group, lat: p.lat, lng: p.lng })),
    },
  });
});

// ADMIN: the full row (phone, UPI, emergency contact, plate). A DRIVER: only their own, approved profile, and only
// non-personal fields. Anyone else (another rider, a pending applicant) gets 404, so ids cannot be probed.
apiRouter.get('/drivers/:id', requireAuth, requireRole('DRIVER', 'ADMIN'), validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const driverId = req.params.id;
    const where = { OR: [{ id: driverId }, { userId: driverId }] };
    if (req.user!.role === Role.ADMIN) {
      const driver = await prisma.driverPartner.findFirst({
        where,
        include: { user: { select: { id: true, name: true, phone: true, role: true, avatarId: true, createdAt: true } } },
      });
      if (!driver) return res.status(404).json({ success: false, message: 'Driver partner not found.' });
      return res.json({ success: true, data: driver });
    }
    const own = await prisma.driverPartner.findFirst({
      where: { AND: [where, { userId: req.user!.id, approvalStatus: 'APPROVED' }] },
      select: {
        id: true, userId: true, name: true, runnerCode: true, vehicleType: true, dutyStatus: true, ordersToday: true, totalEarningsToday: true,
        avgCompletionTimeMinutes: true, onTimeRatePercent: true, rating: true, approvalStatus: true, createdAt: true,
        user: { select: { id: true, name: true, role: true, avatarId: true, createdAt: true } },
      },
    });
    if (!own) return res.status(404).json({ success: false, message: 'Driver partner not found.' });
    return res.json({ success: true, data: own });
  } catch (err: any) {
    return fail(res, err, 'Error fetching driver');
  }
});

// ----------------------------------------------------
// AUTH: students sign in with Google, partners with phone + password (contract: Docs/15_auth_v2_contract.md)
// ----------------------------------------------------
const PLACEHOLDER_NAMES = new Set(['VIT Student', 'Dhaba Owner', 'Delivery Partner']);
const UPI_RE = /^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/;
const AVATAR_COUNT = 15;

const needsProfile = (u: { role: Role; name: string; phone?: string | null; avatarId?: number | null; isStudent?: boolean | null; hostelBlock?: string | null }) =>
  u.role === Role.STUDENT &&
  (!u.name || PLACEHOLDER_NAMES.has(u.name.trim()) || !u.phone || !u.avatarId || u.isStudent === null || u.isStudent === undefined || (u.isStudent === true && !u.hostelBlock));

const publicUser = (u: any) => ({
  id: u.id,
  name: u.name,
  email: u.email ?? null,
  phone: u.phone ?? null,
  role: u.role,
  isStudent: u.isStudent ?? null,
  hostelBlock: u.hostelBlock ?? null,
  avatarId: u.avatarId ?? null,
  kraveoCoins: u.kraveoCoins,
});

// Students: verify the Google ID token, find or create the account.
apiRouter.post('/auth/google', async (req: Request, res: Response) => {
  try {
    const idToken = req.body?.idToken;
    if (typeof idToken !== 'string' || idToken.length < 20) {
      return res.status(400).json({ success: false, message: 'Google sign-in token is missing.' });
    }

    let identity;
    try {
      identity = await verifyGoogleIdToken(idToken);
    } catch (err) {
      if (err instanceof GoogleAuthError) return res.status(err.status).json({ success: false, message: err.message });
      throw err;
    }
    if (!identity.emailVerified) {
      return res.status(401).json({ success: false, message: 'Your Google email is not verified.' });
    }

    // The Google account id (sub) is the identity. An account found only by email is linked to this Google
    // account when it has none yet; it is never re-pointed from one Google account to another.
    let user = await prisma.user.findFirst({ where: { googleSub: identity.sub, deletedAt: null } });
    let isNewUser = false;

    if (!user) {
      const byEmail = await prisma.user.findFirst({ where: { email: identity.email, deletedAt: null } });
      if (byEmail && byEmail.googleSub && byEmail.googleSub !== identity.sub) {
        return res.status(409).json({ success: false, code: 'ACCOUNT_CONFLICT', message: 'This email is already linked to a different Google account. Contact Kraveo support.' });
      }
      user = byEmail;
    }

    if (user) {
      if (user.role !== Role.STUDENT) {
        return res.status(403).json({ success: false, message: 'This Google account belongs to a Kraveo partner. Use the partner app.' });
      }
      if (user.googleSub !== identity.sub || user.email !== identity.email) {
        try {
          user = await prisma.user.update({ where: { id: user.id }, data: { googleSub: identity.sub, email: identity.email } });
        } catch (err: any) {
          if (err?.code === 'P2002') return res.status(409).json({ success: false, code: 'ACCOUNT_CONFLICT', message: 'This Google account is already linked to another Kraveo account. Contact Kraveo support.' });
          throw err;
        }
      }
    } else {
      user = await prisma.user.create({
        data: { email: identity.email, googleSub: identity.sub, name: identity.name.slice(0, 60), role: Role.STUDENT },
      });
      isNewUser = true;
    }

    const token = generateToken({ id: user.id, phone: user.phone, role: user.role, tokenVersion: user.tokenVersion });
    return res.json({ success: true, message: isNewUser ? 'Welcome to Kraveo!' : 'Welcome back!', token, user: publicUser(user), isNewUser, needsProfile: needsProfile(user) });
  } catch (err: any) {
    console.error('google sign-in failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// Partners (vendor / driver): phone + password. Accounts are created by Kraveo only.
apiRouter.post('/auth/partner-login', async (req: Request, res: Response) => {
  try {
    const phone = canonicalPhone(req.body?.phone);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = String(req.body?.role || '').toUpperCase();
    if (!phone || !password || !['VENDOR', 'DRIVER'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Enter your phone number and password.' });
    }

    const key = last10(phone);
    const ip = clientIp(req);
    const ipLocked = ipLockedFor(ip);
    if (ipLocked) {
      return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many wrong attempts from this network. Try again later.', retryAfterSeconds: ipLocked });
    }
    const locked = isLocked(key);
    if (locked) {
      return res.status(429).json({ success: false, message: 'Too many wrong attempts. Try again later.', retryAfterSeconds: locked });
    }

    const user = await prisma.user.findFirst({ where: { phone: { endsWith: key }, role: { in: [Role.VENDOR, Role.DRIVER, Role.ADMIN, Role.STUDENT] }, deletedAt: null } });
    // Always run one scrypt so unknown numbers and wrong passwords take the same time.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !user.passwordHash || !ok) {
      recordIpFailure(ip);
      const retry = recordFailure(key);
      if (retry) return res.status(429).json({ success: false, message: 'Too many wrong attempts. Try again in 15 minutes.', retryAfterSeconds: retry });
      return res.status(401).json({ success: false, message: 'Wrong phone or password.' });
    }
    if (user.role !== role) {
      return res.status(403).json({ success: false, message: 'This account is not registered for this app.' });
    }
    recordSuccess(key);

    const vendors = role === 'VENDOR' ? await prisma.vendor.findMany({ where: { userId: user.id }, select: { id: true, name: true, isAcceptingOrders: true, approvalStatus: true, rejectionReason: true, category: true, address: true, fssaiNumber: true, ...VENDOR_LOCATION_SELECT }, orderBy: { createdAt: 'asc' } }) : [];
    const vendorRow = vendors.find((v) => v.approvalStatus === 'APPROVED') ?? vendors[0] ?? null;
    const vendor = vendorRow ? { ...vendorRow, ...vendorLocationView(vendorRow) } : null;
    const driver = role === 'DRIVER' ? await prisma.driverPartner.findFirst({ where: { userId: user.id }, select: { id: true, runnerCode: true, approvalStatus: true, rejectionReason: true, vehicleType: true, vehicleRegNo: true, emergencyPhone: true, upiId: true, dutyStatus: true } }) : null;
    const approvalStatus = (vendor ?? driver)?.approvalStatus ?? 'APPROVED';
    const rejectionReason = (vendor ?? driver)?.rejectionReason ?? null;

    const token = generateToken({ id: user.id, phone: user.phone, role: user.role, tokenVersion: user.tokenVersion });
    return res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, phone: user.phone, role: user.role, avatarId: user.avatarId ?? null },
      approvalStatus,
      rejectionReason,
      ...(vendor ? { vendor } : {}),
      ...(driver ? { driver } : {}),
    });
  } catch (err: any) {
    console.error('partner-login failed:', errSummary(err));
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// Admin Authentication (Passcode Login for Super Admin Dashboard)
apiRouter.post('/auth/admin-login', async (req: Request, res: Response) => {
  try {
    const { username, passcode } = req.body ?? {};

    if (!passcode) {
      return res.status(400).json({ success: false, message: 'Admin passcode is required.' });
    }

    const configuredPasscode = process.env.ADMIN_PASSCODE;
    if (!configuredPasscode) {
      return res.status(503).json({ success: false, message: 'Admin authentication is not configured on this server.' });
    }

    // Per client IP, and only WRONG passcodes count: a few typos (or an attacker) at one address never lock the admin out elsewhere.
    const requestKey = clientIp(req);
    const blocked = adminLoginFailures.blockedFor(requestKey);
    if (blocked) {
      return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many admin login attempts. Try again later.', retryAfterSeconds: blocked });
    }

    const supplied = Buffer.from(String(passcode).trim());
    const expected = Buffer.from(configuredPasscode);
    const isPasscodeValid = supplied.length === expected.length && timingSafeEqual(supplied, expected);

    if (!isPasscodeValid) {
      adminLoginFailures.fail(requestKey);
      return res.status(401).json({ success: false, message: 'Invalid admin passcode. Access denied.' });
    }

    adminLoginFailures.clear(requestKey);

    // Find or create admin profile in PostgreSQL
    let adminUser = await prisma.user.findFirst({
      where: { role: Role.ADMIN }
    });

    if (!adminUser) {
      adminUser = await prisma.user.create({
        data: {
          name: username || 'Kraveo Super Admin',
          phone: '9999999999',
          role: Role.ADMIN,
          hostelBlock: 'Operations Command Center',
        }
      });
    }

    const token = generateToken({
      id: adminUser.id,
      phone: adminUser.phone,
      role: Role.ADMIN,
      tokenVersion: adminUser.tokenVersion,
    });

    return res.json({
      success: true,
      message: 'Admin authenticated successfully.',
      token,
      admin: {
        id: adminUser.id,
        name: adminUser.name,
        role: adminUser.role,
        phone: adminUser.phone
      }
    });
  } catch (err: any) {
    return fail(res, err, 'Error during admin login');
  }
});



// Get Authenticated User Profile
apiRouter.get('/auth/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ success: false, message: 'User profile not found.' });
    return res.json({ success: true, user: publicUser(user), needsProfile: needsProfile(user) });
  } catch (err: any) {
    return fail(res, err, 'Error fetching profile');
  }
});

// Update profile (role, coins, email and google id can never be changed here)
apiRouter.put('/auth/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const current = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!current) return res.status(404).json({ success: false, message: 'User profile not found.' });

    const { name, phone, isStudent, hostelBlock, avatarId, upiId, fcmToken } = req.body ?? {};
    const isStudentAccount = current.role === Role.STUDENT;
    const bad = (field: string, message: string) => res.status(400).json({ success: false, field, message });
    const updateData: Record<string, any> = {};

    if (name !== undefined) {
      const cleaned = String(name).trim().replace(/\s+/g, ' ');
      if (!NAME_RE.test(cleaned) || PLACEHOLDER_NAMES.has(cleaned)) return bad('name', 'Enter your full name (2 to 60 characters, no symbols).');
      updateData.name = cleaned;
    }
    if (avatarId !== undefined) {
      if (!Number.isInteger(avatarId) || avatarId < 1 || avatarId > AVATAR_COUNT) return bad('avatarId', 'Choose one of the avatars.');
      updateData.avatarId = avatarId;
    }
    if (isStudentAccount) {
      if (phone !== undefined) {
        const canon = canonicalPhone(phone);
        if (!canon) return bad('phone', 'Enter a valid 10-digit Indian mobile number.');
        updateData.phone = canon;
      }
      if (isStudent !== undefined) {
        if (typeof isStudent !== 'boolean') return bad('isStudent', 'Tell us whether you are a student.');
        updateData.isStudent = isStudent;
        if (!isStudent) updateData.hostelBlock = null;
      }
      if (hostelBlock !== undefined) {
        const finalIsStudent = updateData.isStudent ?? current.isStudent;
        if (finalIsStudent !== true) return bad('hostelBlock', 'A hostel block is only needed for students.');
        // Legacy spellings (Block 2, Girls Hostel Gate 1 ...) are accepted and stored as the canonical name (BH2, GH1).
        const canonical = normalizeDropPoint(hostelBlock);
        if (!canonical) return bad('hostelBlock', 'Choose one of the campus drop points.');
        updateData.hostelBlock = canonical;
      }
    }
    if (upiId !== undefined && upiId !== '') {
      const cleaned = String(upiId).trim();
      if (!UPI_RE.test(cleaned)) return bad('upiId', 'Enter a valid UPI ID.');
      updateData.upiId = cleaned;
    }
    if (typeof fcmToken === 'string' && fcmToken.length > 0 && fcmToken.length <= 4096) updateData.fcmToken = fcmToken;

    try {
      const user = await prisma.user.update({ where: { id: req.user.id }, data: updateData });
      return res.json({ success: true, message: 'Profile updated successfully.', user: publicUser(user), needsProfile: needsProfile(user) });
    } catch (err: any) {
      if (err?.code === 'P2002') return bad('phone', 'This phone number is already used by another account.');
      throw err;
    }
  } catch (err: any) {
    return fail(res, err, 'Error updating profile');
  }
});

// Logout: the JWT is stateless, so the useful server-side step is to stop pushing to this device.
apiRouter.post('/auth/logout', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.id) {
      await prisma.user.update({ where: { id: req.user.id }, data: { fcmToken: null } });
      // A rider who logs out is off duty; otherwise the dashboard keeps counting them as online.
      if (req.user.role === Role.DRIVER) {
        await prisma.driverPartner.updateMany({ where: { userId: req.user.id }, data: { dutyStatus: 'OFFLINE' } });
        await dropFromPartnerRooms(req.user.id, ['drivers']);
      }
    }
    return res.json({ success: true });
  } catch {
    return res.json({ success: true });
  }
});

// Delete account (Play Store requires an in-app path). Orders/payments must keep their FK, so the row is anonymised.
apiRouter.delete('/auth/account', requireAuth, requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    // Lock the account row (placing an order takes the same lock), so no order can slip in between the check and the delete.
    const blocked = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const active = await tx.order.count({ where: { customerId: userId, status: { notIn: ['DELIVERED', 'CANCELLED'] } } });
      if (active > 0) return true;
      await tx.user.update({
        where: { id: userId },
        data: {
          name: 'Deleted user', phone: null, email: null, googleSub: null, passwordHash: null, avatarId: null, isStudent: null, hostelBlock: null, fcmToken: null, upiId: null, kraveoCoins: 0,
          deletedAt: new Date(),
          tokenVersion: { increment: 1 }, // every token issued before is dead from now on
        },
      });
      return false;
    });
    if (blocked) {
      return res.status(409).json({ success: false, message: 'You have an order in progress. You can delete your account once it is delivered.' });
    }
    invalidateAuthCache(userId);
    await disableUserTokens(userId, 'ACCOUNT_DELETED'); // no more pushes to this person's phones (never throws)
    return res.json({ success: true, message: 'Your account has been deleted.' });
  } catch (err: any) {
    return fail(res, err, 'Could not delete the account');
  }
});

// ----------------------------------------------------
// ADMIN: partner accounts (vendor / driver). Kraveo creates these; there is no self sign-up.
// ----------------------------------------------------
apiRouter.post('/admin/partners', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const b = req.body ?? {};
    const { role, name, password, vendorId } = b;
    const phone = canonicalPhone(b.phone);
    const bad = (field: string, message: string) => res.status(400).json({ success: false, field, message });
    if (!['VENDOR', 'DRIVER'].includes(role)) return bad('role', 'Role must be VENDOR or DRIVER.');
    const cleanedName = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(cleanedName.replace(/[()]/g, ''))) return bad('name', 'Enter the partner name.');
    if (!phone) return bad('phone', 'Enter a valid 10-digit Indian mobile number.');
    const problem = passwordProblem(password);
    if (problem) return bad('password', problem);

    if (await prisma.user.findFirst({ where: { phone: { endsWith: last10(phone) } } })) {
      return res.status(409).json({ success: false, field: 'phone', message: 'This phone number already has an account.' });
    }

    // Vendor: either link an existing restaurant (vendorId) or create the restaurant together with its owner.
    let vendorData: { name: string; category: string; address: string; fssaiNumber: string | null } | null = null;
    let pin: { lat: number; lng: number } | null = null;
    if (role === 'VENDOR') {
      if (vendorId) {
        const vendor = await prisma.vendor.findUnique({ where: { id: String(vendorId) } });
        if (!vendor) return bad('vendorId', 'That restaurant does not exist.');
        if (vendor.userId) return res.status(409).json({ success: false, field: 'vendorId', message: 'That restaurant already has an owner account.' });
      } else {
        const v = validateVendorFields(b);
        if (!v.ok) return bad(v.error.field, v.error.message);
        vendorData = v.data;
        if (b.lat !== undefined || b.lng !== undefined) {
          const check = checkVendorLocation(b.lat, b.lng);
          if (!check.ok) return bad(check.field, check.message);
          pin = { lat: check.lat, lng: check.lng };
        }
      }
    }
    let driverData: { vehicleType: string; vehicleRegNo: string | null; emergencyPhone: string | null; upiId: string | null } | null = null;
    if (role === 'DRIVER') {
      const d = validateDriverFields({ vehicleType: 'Scooter', ...b }, phone, false);
      if (!d.ok) return bad(d.error.field, d.error.message);
      driverData = d.data;
    }

    const passwordHash = await hashPassword(password);
    const runnerCode = role === 'DRIVER' ? String(b.runnerCode || '').trim() || await newRunnerCode() : '';
    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { name: cleanedName, phone, role: role as Role, passwordHash } });
      let profileId: string | null = null;
      if (role === 'VENDOR' && vendorId) {
        await tx.vendor.update({ where: { id: String(vendorId) }, data: { userId: created.id } });
        profileId = String(vendorId);
      } else if (role === 'VENDOR' && vendorData) {
        const v = await tx.vendor.create({ data: { ...vendorData, userId: created.id, bannerImage: DEFAULT_BANNER, isAcceptingOrders: true, approvalStatus: 'APPROVED', ...(pin ? adminPinData(pin.lat, pin.lng) : {}) } });
        profileId = v.id;
      }
      if (role === 'DRIVER' && driverData) {
        const d = await tx.driverPartner.create({ data: { userId: created.id, name: cleanedName, phone, runnerCode, ...driverData, approvalStatus: 'APPROVED' } });
        profileId = d.id;
      }
      return { created, profileId };
    });
    await writeAudit('PARTNER_CREATED', role, result.profileId ?? result.created.id, `Admin created ${String(role).toLowerCase()} ${cleanedName} (${phone})`);
    return res.status(201).json({ success: true, user: { id: result.created.id, name: result.created.name, phone: result.created.phone, role: result.created.role }, profileId: result.profileId });
  } catch (err: any) {
    return fail(res, err, 'Could not create the partner');
  }
});

apiRouter.get('/admin/partners', requireAuth, requireRole('ADMIN'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: { in: [Role.VENDOR, Role.DRIVER] } },
      select: { id: true, name: true, phone: true, role: true, createdAt: true, vendorsOwned: { select: { id: true, name: true, approvalStatus: true, ...VENDOR_LOCATION_SELECT } }, driverProfile: { select: { id: true, runnerCode: true, approvalStatus: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const data = users.map((u) => ({ ...u, vendorsOwned: u.vendorsOwned.map((v) => ({ ...v, ...vendorLocationView(v) })) }));
    return res.json({ success: true, data });
  } catch (err: any) {
    return fail(res, err, 'Could not list partners');
  }
});

// Register FCM Push Notification Token
apiRouter.post('/notifications/register-token', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '' || fcmToken.length > 4096) {
      return res.status(400).json({ success: false, message: 'fcmToken is required (up to 4096 characters).' });
    }

    if (req.user?.id) {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { fcmToken }
      });
    }

    return res.json({ success: true, message: 'FCM push notification token registered successfully.' });
  } catch (err: any) {
    return fail(res, err, 'Error registering token');
  }
});

// ----------------------------------------------------
// VENDOR / DHABA ENDPOINTS
// ----------------------------------------------------
// Customers get the public shape (no owner id, FSSAI number, review state, timestamps). Admins and the owning
// restaurant keep the full row.
const fullVendorView = (v: any, viewer: { id: string; role: Role } | null) =>
  viewer?.role === Role.ADMIN || (viewer?.role === Role.VENDOR && !!v.userId && v.userId === viewer.id) ? { ...v, hasLocation: vendorHasLocation(v.lat, v.lng) } : null;

apiRouter.get('/vendors', async (req: Request, res: Response) => {
  try {
    const viewer = await optionalViewer(req);
    const dbVendors = await prisma.vendor.findMany({ include: { menuItems: true } });
    const visible = dbVendors.filter((v) => canSeeVendor(v, viewer)).map((v) => fullVendorView(v, viewer) ?? publicVendorView(v));
    return res.json({ success: true, count: visible.length, data: visible });
  } catch (err: any) {
    return fail(res, err, 'Error fetching vendors');
  }
});

apiRouter.get('/vendors/:id', validParams('id'), async (req: Request, res: Response) => {
  try {
    const dbVendor = await prisma.vendor.findUnique({
      where: { id: req.params.id },
      include: { menuItems: true }
    });
    const viewer = await optionalViewer(req);
    if (!dbVendor || !canSeeVendor(dbVendor, viewer)) return res.status(404).json({ success: false, message: 'Vendor not found' });
    const shaped = fullVendorView(dbVendor, viewer) ?? publicVendorView(dbVendor);
    return res.json({ success: true, data: { ...shaped, menu: shaped.menuItems } });
  } catch (err: any) {
    return fail(res, err, 'Error fetching vendor');
  }
});

apiRouter.post('/vendors', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, category, address, lat, lng, bannerImage } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) {
      return res.status(400).json({ success: false, message: 'Vendor name is required (up to 60 characters).' });
    }
    for (const [field, value, max] of [['category', category, 60], ['address', address, 140], ['bannerImage', bannerImage, 500]] as const) {
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > max)) {
        return res.status(400).json({ success: false, field, message: `${field} must be text of at most ${max} characters.` });
      }
    }

    let pin: { lat: number; lng: number } | null = null;
    if (lat !== undefined || lng !== undefined) {
      const check = checkVendorLocation(lat, lng);
      if (!check.ok) return res.status(400).json({ success: false, field: check.field, message: check.message });
      pin = { lat: check.lat, lng: check.lng };
    }

    const createdVendor = await prisma.vendor.create({
      data: {
        name: name.trim(),
        category: category || 'North Indian • Campus Dhaba',
        address: address || 'Ashta Highway, near VIT Bhopal',
        lat: pin ? pin.lat : 23.0768,
        lng: pin ? pin.lng : 76.8524,
        ...(pin ? adminPinData(pin.lat, pin.lng) : {}),
        bannerImage: bannerImage || 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600',
        isAcceptingOrders: true,
      },
      include: { menuItems: true }
    });

    return res.status(201).json({ success: true, message: 'Vendor onboarded successfully', data: createdVendor });
  } catch (err: any) {
    return fail(res, err, 'Error onboarding vendor');
  }
});

// ADMIN: set a restaurant's map pin (Docs/19). Numbers only, real ranges, within 3 km of the campus centre; audit-logged.
apiRouter.patch('/admin/vendors/:id/location', requireAuth, requireRole('ADMIN'), validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const check = checkVendorLocation(body.lat, body.lng);
    if (!check.ok) return res.status(400).json({ success: false, field: check.field, message: check.message });
    const existing = await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, ...VENDOR_LOCATION_SELECT } });
    if (!existing) return res.status(404).json({ success: false, message: 'Vendor not found' });
    const updated = await prisma.vendor.update({ where: { id: existing.id }, data: adminPinData(check.lat, check.lng), select: { id: true, name: true, ...VENDOR_LOCATION_SELECT } });
    await writeAudit('VENDOR_LOCATION_SET', 'VENDOR', updated.id, `Admin set the map location of ${updated.name} to ${check.lat.toFixed(6)}, ${check.lng.toFixed(6)}; previous: ${describePin(existing)}`);
    return res.json({ success: true, data: { ...updated, hasLocation: vendorHasLocation(updated.lat, updated.lng) } });
  } catch (err: any) {
    return fail(res, err, 'Error setting the vendor location');
  }
});

apiRouter.patch('/vendors/:id/status', requireAuth, validParams('id'), requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { isAcceptingOrders } = req.body;
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
    if (!(await canManageVendor(vendor.id, req.user))) return res.status(403).json({ success: false, message: 'Forbidden. You do not own this vendor.' });

    if (typeof isAcceptingOrders !== 'boolean') return res.status(400).json({ success: false, message: 'isAcceptingOrders boolean field is required.' });
    const newStatus = isAcceptingOrders;

    const updated = await prisma.vendor.update({
      where: { id: req.params.id },
      data: { isAcceptingOrders: newStatus }
    });
    return res.json({ success: true, isAcceptingOrders: updated.isAcceptingOrders, data: updated });
  } catch (err: any) {
    return fail(res, err, 'Error updating vendor status');
  }
});

apiRouter.patch('/vendors/:id/toggle', requireAuth, validParams('id'), requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
    if (!(await canManageVendor(vendor.id, req.user))) return res.status(403).json({ success: false, message: 'Forbidden. You do not own this vendor.' });

    const updated = await prisma.vendor.update({
      where: { id: req.params.id },
      data: { isAcceptingOrders: !vendor.isAcceptingOrders }
    });
    return res.json({ success: true, isAcceptingOrders: updated.isAcceptingOrders });
  } catch (err: any) {
    return fail(res, err, 'Error toggling vendor');
  }
});

apiRouter.post('/vendors/:id/items', requireAuth, requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, validParams('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const v = validateMenuItemFields(req.body);
    if (!v.ok) return res.status(400).json({ success: false, code: 'BAD_REQUEST', field: v.error.field, message: v.error.message });
    if (!(await canManageVendor(req.params.id, req.user))) return res.status(403).json({ success: false, message: 'Forbidden. You do not own this vendor.' });
    if (!(await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { id: true } }))) return res.status(404).json({ success: false, message: 'Vendor not found' });

    const newItem = await prisma.menuItem.create({
      data: {
        vendorId: req.params.id,
        name: v.data.name,
        price: v.data.price,
        category: v.data.category,
        description: v.data.description,
        isVeg: v.data.isVeg,
        imageUrl: v.data.imageUrl || 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400',
        isAvailable: true,
      }
    });

    return res.status(201).json({ success: true, message: 'Menu item created successfully', data: newItem });
  } catch (err: any) {
    return fail(res, err, 'Error creating menu item');
  }
});

// ----------------------------------------------------
// MENU ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/menus/:vendorId', validParams('vendorId'), async (req: Request, res: Response) => {
  try {
    const owner = await prisma.vendor.findUnique({ where: { id: req.params.vendorId }, select: { approvalStatus: true, userId: true } });
    const viewer = await optionalViewer(req);
    if (!owner || !canSeeVendor(owner, viewer)) return res.json({ success: true, count: 0, data: [] });
    const dbItems = await prisma.menuItem.findMany({ where: { vendorId: req.params.vendorId } });
    const full = viewer?.role === Role.ADMIN || (viewer?.role === Role.VENDOR && owner.userId === viewer.id);
    const data = full ? dbItems : dbItems.map(publicMenuItem);
    return res.json({ success: true, count: data.length, data });
  } catch (err: any) {
    return fail(res, err, 'Error fetching menu items');
  }
});

apiRouter.patch('/menus/:itemId/toggle', requireAuth, requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, validParams('itemId'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dbItem = await prisma.menuItem.findUnique({ where: { id: req.params.itemId } });
    if (!dbItem) return res.status(404).json({ success: false, message: 'Menu item not found' });
    if (!(await canManageVendor(dbItem.vendorId, req.user))) return res.status(403).json({ success: false, message: 'Forbidden. You do not own this vendor.' });

    const updated = await prisma.menuItem.update({
      where: { id: req.params.itemId },
      data: { isAvailable: !dbItem.isAvailable }
    });
    return res.json({ success: true, item: updated });
  } catch (err: any) {
    return fail(res, err, 'Error toggling menu item');
  }
});

// Admin reporting is calculated from persisted orders so dashboard metrics never drift from operations.
apiRouter.get('/analytics', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const range = req.query.range === 'today' || req.query.range === '30d' ? req.query.range : '7d';
    const now = new Date();
    // "Today" starts at midnight Asia/Kolkata, whatever time zone the server runs in (utils/time.ts).
    const from = range === 'today' ? startOfIstDay(now) : new Date(now.getTime() - (range === '30d' ? 30 : 7) * 24 * 60 * 60 * 1000);

    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: from, lte: now } },
      select: { totalAmount: true, paymentStatus: true, status: true, customerId: true, dropoffHostel: true, createdAt: true, deliveredAt: true, vendor: { select: { name: true } } }
    });
    const completed = orders.filter((order) => order.status === 'DELIVERED');
    const paid = orders.filter((order) => order.paymentStatus === 'PAID');
    const vendorTotals = new Map<string, number>();
    const hostelTotals = new Map<string, number>();
    const hourlyTotals = new Map<number, number>();
    for (const order of orders) {
      if (order.status !== 'CANCELLED') {
        hostelTotals.set(order.dropoffHostel, (hostelTotals.get(order.dropoffHostel) || 0) + 1);
        const hour = istHour(order.createdAt); // Asia/Kolkata clock hour, not the server's
        hourlyTotals.set(hour, (hourlyTotals.get(hour) || 0) + 1);
      }
      if (order.status === 'DELIVERED') vendorTotals.set(order.vendor.name, (vendorTotals.get(order.vendor.name) || 0) + 1);
    }
    const topVendor = [...vendorTotals.entries()].sort((a, b) => b[1] - a[1])[0];
    // Order-to-door time: deliveredAt - createdAt. (updatedAt moves whenever the row is touched, e.g. by a later review.)
    const timedDeliveries = completed.filter((order) => order.deliveredAt);
    const averageDeliveryMinutes = timedDeliveries.length
      ? timedDeliveries.reduce((sum, order) => sum + Math.max(0, order.deliveredAt!.getTime() - order.createdAt.getTime()) / 60000, 0) / timedDeliveries.length
      : 0;
    return res.json({
      success: true,
      data: {
        range: { from: from.toISOString(), to: now.toISOString() },
        grossOrderVolume: paid.reduce((sum, order) => sum + order.totalAmount, 0),
        orderCount: orders.length,
        averageDeliveryMinutes: Math.round(averageDeliveryMinutes * 10) / 10,
        activeStudents: new Set(orders.filter((order) => order.status !== 'CANCELLED').map((order) => order.customerId)).size,
        cancellationRate: orders.length ? Math.round((orders.filter((order) => order.status === 'CANCELLED').length / orders.length) * 1000) / 10 : 0,
        hourlyOrders: Array.from({ length: 24 }, (_, hour) => ({ hour: `${hour.toString().padStart(2, '0')}:00`, orders: hourlyTotals.get(hour) || 0 })),
        hostelOrders: [...hostelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([hostel, count]) => ({ hostel, orders: count })),
        topVendor: topVendor ? { name: topVendor[0], deliveredOrders: topVendor[1] } : undefined,
        generatedAt: now.toISOString(),
      }
    });
  } catch (err: any) {
    return fail(res, err, 'Error calculating analytics');
  }
});

// Update Menu Item Stock Availability & Price (Prisma DB Persistence)
apiRouter.patch('/vendors/items/:itemId', requireAuth, requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, validParams('itemId'), async (req: AuthenticatedRequest, res: Response) => {
  const { isAvailable, price } = req.body ?? {};

  const updateData: any = {};
  if (isAvailable !== undefined && typeof isAvailable !== 'boolean') return res.status(400).json({ success: false, code: 'BAD_REQUEST', field: 'isAvailable', message: 'isAvailable must be true or false.' });
  if (typeof isAvailable === 'boolean') updateData.isAvailable = isAvailable;
  if (price !== undefined) {
    const problem = priceProblem(price);
    if (problem) return res.status(400).json({ success: false, code: 'BAD_REQUEST', field: 'price', message: problem });
    updateData.price = price;
  }
  if (Object.keys(updateData).length === 0) return res.status(400).json({ success: false, code: 'BAD_REQUEST', message: 'Send isAvailable and/or price.' });

  try {
    // A restaurant may only change its own menu (was: any item of any restaurant).
    const item = await prisma.menuItem.findUnique({ where: { id: req.params.itemId }, select: { vendorId: true } });
    if (!item) return res.status(404).json({ success: false, message: 'Menu item not found' });
    if (!(await canManageVendor(item.vendorId, req.user))) return res.status(403).json({ success: false, message: 'Forbidden. You do not own this vendor.' });
    const updated = await prisma.menuItem.update({
      where: { id: req.params.itemId },
      data: updateData
    });
    return res.json({ success: true, message: 'Menu item updated successfully.', item: updated });
  } catch (err: any) {
    return fail(res, err, 'Error updating menu item');
  }
});

// ----------------------------------------------------
// REVIEWS & KRAVEO COIN LOYALTY REWARDS ENDPOINTS
// ----------------------------------------------------

// Submit Order & Dish Review (Earns +10 Kraveo Coins & Updates Dhaba Rating)
const COUPON_COIN_COST = 50;
const MAX_REVIEW_TEXT = 300;
const MAX_DISH_REVIEWS = 30;
const MAX_DRIVER_TAGS = 10;
const isRating = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;
const reviewText = (raw: unknown): string | null | false => {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return false;
  const t = raw.trim();
  return t.length <= MAX_REVIEW_TEXT ? t : false;
};
const reviewBad = (res: Response, field: string, message: string) => res.status(400).json({ success: false, code: 'BAD_REQUEST', field, message });

apiRouter.post('/reviews', requireAuth, requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const { orderId, driverRating, driverTags, dishReviews } = b;

  if (typeof orderId !== 'string' || !ID_RE.test(orderId)) return reviewBad(res, 'orderId', 'orderId is required.');
  if (driverRating !== undefined && driverRating !== null && !isRating(driverRating)) return reviewBad(res, 'driverRating', 'driverRating must be a whole number from 1 to 5.');
  const driverNotes = reviewText(b.driverNotes);
  if (driverNotes === false) return reviewBad(res, 'driverNotes', `Notes can be at most ${MAX_REVIEW_TEXT} characters.`);
  const dhabaNotes = reviewText(b.dhabaNotes);
  if (dhabaNotes === false) return reviewBad(res, 'dhabaNotes', `Notes can be at most ${MAX_REVIEW_TEXT} characters.`);
  let tags: string[] = [];
  if (driverTags !== undefined && driverTags !== null) {
    if (!Array.isArray(driverTags) || driverTags.length > MAX_DRIVER_TAGS || driverTags.some((t) => typeof t !== 'string' || t.length === 0 || t.length > 40)) {
      return reviewBad(res, 'driverTags', `driverTags must be a list of up to ${MAX_DRIVER_TAGS} short texts.`);
    }
    tags = driverTags;
  }
  const dishes: { dishId: string; rating: number }[] = [];
  if (dishReviews !== undefined && dishReviews !== null) {
    if (!Array.isArray(dishReviews) || dishReviews.length > MAX_DISH_REVIEWS) return reviewBad(res, 'dishReviews', `dishReviews must be a list of at most ${MAX_DISH_REVIEWS} ratings.`);
    const seen = new Set<string>();
    for (const dr of dishReviews) {
      if (!dr || typeof dr !== 'object' || typeof dr.dishId !== 'string' || !ID_RE.test(dr.dishId) || !isRating(dr.rating)) {
        return reviewBad(res, 'dishReviews', 'Every dish rating needs a dishId and a whole number rating from 1 to 5.');
      }
      if (seen.has(dr.dishId)) return reviewBad(res, 'dishReviews', 'Each dish can be rated once.');
      seen.add(dr.dishId);
      dishes.push({ dishId: dr.dishId, rating: dr.rating });
    }
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Row lock: two taps on "Submit" run one after the other, the second sees isReviewed.
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { select: { menuItemId: true } } } });
      if (!order) {
        throw new Error('ORDER_NOT_FOUND');
      }

      if (order.customerId !== req.user?.id || order.status !== 'DELIVERED') {
        throw new Error('FORBIDDEN');
      }

      if (order.isReviewed) {
        throw new Error('ALREADY_REVIEWED');
      }

      const inOrder = new Set(order.items.map((i) => i.menuItemId).filter((x): x is string => !!x));
      if (dishes.some((d) => !inOrder.has(d.dishId))) {
        throw new Error('DISH_NOT_IN_ORDER');
      }

      const customerId = order.customerId;

      // 1. Update User's Kraveo Coins (+10 per review)
      const updatedUser = await tx.user.update({
        where: { id: customerId },
        data: { kraveoCoins: { increment: 10 } }
      });

      // 2. Mark Order as reviewed
      await tx.order.update({
        where: { id: orderId },
        data: { isReviewed: true }
      });

      // 3. Process Dish Ratings & Update Menu Item Rating Metrics
      for (const dr of dishes) {
        const item = await tx.menuItem.findUnique({ where: { id: dr.dishId } });
        if (item) {
          const currRating = item.rating || 4.5;
          const currCount = item.ratingCount || 10;
          const newCount = currCount + 1;
          const newRating = parseFloat(((currRating * currCount + dr.rating) / newCount).toFixed(2));
          await tx.menuItem.update({
            where: { id: item.id },
            data: { rating: newRating, ratingCount: newCount }
          });
        }
      }

      // 4. The restaurant's rating is NOT changed here. The single star value of this request (`driverRating`) is the RIDER's
      // rating (the app shows it under "Your rider" with rider tags); the food is rated per dish (step 3). Feeding the rider's
      // stars into the restaurant average made a good meal with a slow rider lower the restaurant, and the old Bayesian
      // formula re-added its prior on every review so even all-5-star reviews pulled a 4.8 restaurant down. A restaurant
      // rating needs its own input from the app; until then the stored value stays as it is.
      const updatedVendor = await tx.vendor.findUnique({ where: { id: order.vendorId }, select: { rating: true } });

      // 5. Update Driver Partner Rating if driver is assigned
      if (order.driverId && typeof driverRating === 'number') {
        const driver = await tx.driverPartner.findFirst({
          where: { OR: [{ id: order.driverId }, { userId: order.driverId }] }
        });
        if (driver) {
          const newDriverRating = parseFloat(((driver.rating * 20 + driverRating) / 21).toFixed(2));
          await tx.driverPartner.update({
            where: { id: driver.id },
            data: { rating: newDriverRating }
          });
        }
      }

      // 6. Save Review Record
      const newReview = await tx.reviewRecord.create({
        data: {
          orderId,
          customerId,
          vendorId: order.vendorId,
          driverId: order.driverId,
          driverRating: typeof driverRating === 'number' ? driverRating : 5,
          driverTags: tags,
          driverNotes: driverNotes || '',
          dishReviews: dishes,
          dhabaNotes: dhabaNotes || '',
          coinsEarned: 10
        }
      });

      return { updatedUser, updatedVendor, newReview };
    });

    console.log(`🪙 [Kraveo Coins Loyalty] User (${result.updatedUser.id}) earned +10 Kraveo Coins! Total Balance: ${result.updatedUser.kraveoCoins}`);

    return res.json({
      success: true,
      message: '🎉 Review submitted successfully! You earned +10 Kraveo Coins!',
      coinsEarned: 10,
      totalCoins: result.updatedUser.kraveoCoins,
      newVendorRating: result.updatedVendor?.rating,
      review: { id: result.newReview.id, orderId, driverRating: result.newReview.driverRating, driverTags: result.newReview.driverTags, driverNotes: result.newReview.driverNotes, dishReviews: result.newReview.dishReviews, dhabaNotes: result.newReview.dhabaNotes, coinsEarned: result.newReview.coinsEarned, createdAt: result.newReview.createdAt }
    });
  } catch (err: any) {
    if (err.message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    if (err.message === 'ALREADY_REVIEWED' || err?.code === 'P2002') {
      return res.status(400).json({ success: false, message: 'This order has already been reviewed.' });
    }
    if (err.message === 'FORBIDDEN') {
      return res.status(403).json({ success: false, message: 'Only the student who placed a delivered order can review it.' });
    }
    if (err.message === 'DISH_NOT_IN_ORDER') {
      return reviewBad(res, 'dishReviews', 'You can only rate dishes that were in this order.');
    }
    return fail(res, err, 'Error submitting review');
  }
});

// Redeem 50 Kraveo Coins for the KRAVEO20 coupon (Flat ₹20 OFF, minimum order ₹80). The coins are taken here,
// atomically, and the redemption is recorded on the account: KRAVEO20 only works at checkout while the customer
// holds an unused redemption (see utils/validation.ts + services/orderFlow.ts), so the public code is worth nothing alone.
apiRouter.post('/coupons/redeem-coins', requireAuth, requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Unauthorized' });

    // Atomic update eliminating concurrency race conditions
    const updateResult = await prisma.user.updateMany({
      where: { id: req.user.id, kraveoCoins: { gte: COUPON_COIN_COST }, deletedAt: null },
      data: { kraveoCoins: { decrement: COUPON_COIN_COST }, kraveo20Redeemed: { increment: 1 } }
    });

    if (updateResult.count === 0) {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      const currentCoins = user?.kraveoCoins || 0;
      return res.status(400).json({
        success: false,
        code: 'INSUFFICIENT_COINS',
        message: `Insufficient Kraveo Coins. You have ${currentCoins} coins, but need ${COUPON_COIN_COST} coins to redeem ₹20 OFF.`
      });
    }

    const updatedUser = await prisma.user.findUnique({ where: { id: req.user.id } });

    return res.json({
      success: true,
      message: '🎉 Redeemed 50 Kraveo Coins for Flat ₹20 OFF!',
      couponCode: 'KRAVEO20',
      discountAmount: 20,
      remainingCoins: updatedUser?.kraveoCoins || 0
    });
  } catch (err: any) {
    return fail(res, err, 'Error redeeming coins');
  }
});

// Reviews are shown to signed-in users only, newest first, 20 per page (max 50, `cursor` = last id of the page before).
// Only what the screen needs: ratings, texts and the reviewer's first name. No customer / driver / order ids.
const reviewPage = async (req: Request, res: Response, where: Record<string, unknown>) => {
  const requested = Number.parseInt(String(req.query.limit ?? ''), 10);
  const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 20, 50);
  const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined;
  if (cursor && !ID_RE.test(cursor)) return res.status(400).json({ success: false, code: 'BAD_REQUEST', field: 'cursor', message: 'Invalid cursor.' });
  const page = await prisma.reviewRecord.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, driverRating: true, driverTags: true, driverNotes: true, dishReviews: true, dhabaNotes: true, createdAt: true, customer: { select: { name: true } } },
  });
  const hasMore = page.length > limit;
  const rows = hasMore ? page.slice(0, limit) : page;
  const data = rows.map(({ customer, ...r }) => ({ ...r, reviewer: (customer?.name || 'Student').trim().split(/\s+/)[0] }));
  return res.json({ success: true, count: data.length, nextCursor: hasMore ? rows[rows.length - 1].id : null, data });
};

// Fetch Dhaba Reviews
apiRouter.get('/reviews/vendor/:vendorId', requireAuth, validParams('vendorId'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    return await reviewPage(req, res, { vendorId: req.params.vendorId });
  } catch (err: any) {
    return fail(res, err, 'Error fetching vendor reviews');
  }
});

// Fetch Driver Reviews
apiRouter.get('/reviews/driver/:driverId', requireAuth, validParams('driverId'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const driverIdParam = req.params.driverId;
    const driver = await prisma.driverPartner.findFirst({
      where: { OR: [{ id: driverIdParam }, { userId: driverIdParam }] }
    });

    const targetIds = [driverIdParam];
    if (driver?.id && !targetIds.includes(driver.id)) targetIds.push(driver.id);
    if (driver?.userId && !targetIds.includes(driver.userId)) targetIds.push(driver.userId);

    return await reviewPage(req, res, { driverId: { in: targetIds } });
  } catch (err: any) {
    return fail(res, err, 'Error fetching driver reviews');
  }
});
