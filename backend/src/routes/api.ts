import { Router, Request, Response } from 'express';
import { Role } from '@prisma/client';
import { generateToken, requireAuth, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../db';
import { canonicalPhone, last10 } from '../utils/phone';
import { hashPassword, verifyPassword, getDummyHash, passwordProblem } from '../services/password';
import { isLocked, recordFailure, recordSuccess } from '../services/loginLimiter';
import { verifyGoogleIdToken, GoogleAuthError } from '../services/googleAuth';
import { timingSafeEqual } from 'crypto';
import { orderRouter } from './orders';
import { partnerRouter, requireApprovedPartner, validateVendorFields, validateDriverFields, newRunnerCode, writeAudit, DEFAULT_BANNER } from './partners';
import { verifyToken } from '../middleware/auth';

export const apiRouter = Router();

// Partner sign-up, applications, approval and admin customer views live in ./partners.
apiRouter.use(partnerRouter);
// Orders, payments, rider pool, gate OTP and the admin order tools live in ./orders.
apiRouter.use(orderRouter);

const adminLoginAttempts = new Map<string, { count: number; resetAt: number }>();
const canManageVendor = async (vendorId: string, user: AuthenticatedRequest['user']) => {
  if (user?.role === Role.ADMIN) return true;
  if (user?.role !== Role.VENDOR) return false;
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
  return vendor?.userId === user.id;
};

/** Public catalogue routes do not require a login, but admins and the owning vendor may still see unapproved restaurants. */
const optionalViewer = (req: Request): { id: string; role: Role } | null => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    const decoded = verifyToken(header.split(' ')[1]);
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
    return res.status(500).json({ success: false, message: err.message || 'Error fetching drivers' });
  }
});

apiRouter.get('/drivers/locations', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dbLocs = await prisma.driverLocation.findMany({
      where: req.user?.role === Role.ADMIN ? undefined : { driverId: req.user?.id }
    });
    return res.json({ success: true, data: dbLocs });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching driver locations' });
  }
});

apiRouter.get('/drivers/:id', requireAuth, requireRole('DRIVER', 'ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const driverId = req.params.id;
    const driver = await prisma.driverPartner.findFirst({
      where: { OR: [{ id: driverId }, { userId: driverId }] },
      include: { user: { select: { id: true, name: true, phone: true, role: true, avatarId: true, createdAt: true } } }
    });
    if (!driver) return res.status(404).json({ success: false, message: 'Driver partner not found.' });
    return res.json({ success: true, data: driver });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching driver' });
  }
});

// ----------------------------------------------------
// AUTH: students sign in with Google, partners with phone + password (contract: Docs/15_auth_v2_contract.md)
// ----------------------------------------------------
const PLACEHOLDER_NAMES = new Set(['VIT Student', 'Dhaba Owner', 'Delivery Partner']);
const NAME_RE = /^[\p{L}][\p{L}\s.'\-]{1,59}$/u;
const HOSTEL_RE = /^(Block [1-6]|Girls Gate [12]|VIT Main Gate|Boys Hostel Block [1-6]|Girls Hostel Gate [12])$/;
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

    let user = await prisma.user.findFirst({ where: { OR: [{ googleSub: identity.sub }, { email: identity.email }] } });
    let isNewUser = false;

    if (user) {
      if (user.role !== Role.STUDENT) {
        return res.status(403).json({ success: false, message: 'This Google account belongs to a Kraveo partner. Use the partner app.' });
      }
      if (user.googleSub !== identity.sub || user.email !== identity.email) {
        user = await prisma.user.update({ where: { id: user.id }, data: { googleSub: identity.sub, email: identity.email } });
      }
    } else {
      user = await prisma.user.create({
        data: { email: identity.email, googleSub: identity.sub, name: identity.name.slice(0, 60), role: Role.STUDENT },
      });
      isNewUser = true;
    }

    const token = generateToken({ id: user.id, phone: user.phone, role: user.role });
    return res.json({ success: true, message: isNewUser ? 'Welcome to Kraveo!' : 'Welcome back!', token, user: publicUser(user), isNewUser, needsProfile: needsProfile(user) });
  } catch (err: any) {
    console.error('google sign-in failed:', err);
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
    const locked = isLocked(key);
    if (locked) {
      return res.status(429).json({ success: false, message: 'Too many wrong attempts. Try again later.', retryAfterSeconds: locked });
    }

    const user = await prisma.user.findFirst({ where: { phone: { endsWith: key }, role: { in: [Role.VENDOR, Role.DRIVER, Role.ADMIN, Role.STUDENT] } } });
    // Always run one scrypt so unknown numbers and wrong passwords take the same time.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !user.passwordHash || !ok) {
      const retry = recordFailure(key);
      if (retry) return res.status(429).json({ success: false, message: 'Too many wrong attempts. Try again in 15 minutes.', retryAfterSeconds: retry });
      return res.status(401).json({ success: false, message: 'Wrong phone or password.' });
    }
    if (user.role !== role) {
      return res.status(403).json({ success: false, message: 'This account is not registered for this app.' });
    }
    recordSuccess(key);

    const vendors = role === 'VENDOR' ? await prisma.vendor.findMany({ where: { userId: user.id }, select: { id: true, name: true, isAcceptingOrders: true, approvalStatus: true, rejectionReason: true }, orderBy: { createdAt: 'asc' } }) : [];
    const vendor = vendors.find((v) => v.approvalStatus === 'APPROVED') ?? vendors[0] ?? null;
    const driver = role === 'DRIVER' ? await prisma.driverPartner.findFirst({ where: { userId: user.id }, select: { id: true, runnerCode: true, approvalStatus: true, rejectionReason: true } }) : null;
    const approvalStatus = (vendor ?? driver)?.approvalStatus ?? 'APPROVED';
    const rejectionReason = (vendor ?? driver)?.rejectionReason ?? null;

    const token = generateToken({ id: user.id, phone: user.phone, role: user.role });
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
    console.error('partner-login failed:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// Admin Authentication (Passcode Login for Super Admin Dashboard)
apiRouter.post('/auth/admin-login', async (req: Request, res: Response) => {
  try {
    const { username, passcode } = req.body;

    if (!passcode) {
      return res.status(400).json({ success: false, message: 'Admin passcode is required.' });
    }

    const configuredPasscode = process.env.ADMIN_PASSCODE;
    if (!configuredPasscode) {
      return res.status(503).json({ success: false, message: 'Admin authentication is not configured on this server.' });
    }

    const requestKey = req.ip || 'unknown';
    const now = Date.now();
    const attempt = adminLoginAttempts.get(requestKey);
    if (attempt && now < attempt.resetAt && attempt.count >= 5) {
      return res.status(429).json({ success: false, message: 'Too many admin login attempts. Try again later.' });
    }
    if (!attempt || now >= attempt.resetAt) {
      adminLoginAttempts.set(requestKey, { count: 1, resetAt: now + 15 * 60 * 1000 });
    } else {
      attempt.count += 1;
    }

    const supplied = Buffer.from(String(passcode).trim());
    const expected = Buffer.from(configuredPasscode);
    const isPasscodeValid = supplied.length === expected.length && timingSafeEqual(supplied, expected);

    if (!isPasscodeValid) {
      return res.status(401).json({ success: false, message: 'Invalid admin passcode. Access denied.' });
    }

    adminLoginAttempts.delete(requestKey);

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
      role: Role.ADMIN
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
    return res.status(500).json({ success: false, message: err.message || 'Error during admin login.' });
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
    return res.status(500).json({ success: false, message: err.message || 'Error fetching profile' });
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
      if (!NAME_RE.test(cleaned) || PLACEHOLDER_NAMES.has(cleaned)) return bad('name', 'Enter your full name (2-60 letters).');
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
        const cleaned = String(hostelBlock).trim();
        if (!HOSTEL_RE.test(cleaned)) return bad('hostelBlock', 'Choose one of the campus drop points.');
        updateData.hostelBlock = cleaned;
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
    return res.status(500).json({ success: false, message: err.message || 'Error updating profile' });
  }
});

// Logout: the JWT is stateless, so the useful server-side step is to stop pushing to this device.
apiRouter.post('/auth/logout', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.id) {
      await prisma.user.update({ where: { id: req.user.id }, data: { fcmToken: null } });
      // A rider who logs out is off duty; otherwise the dashboard keeps counting them as online.
      if (req.user.role === Role.DRIVER) await prisma.driverPartner.updateMany({ where: { userId: req.user.id }, data: { dutyStatus: 'OFFLINE' } });
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
    const active = await prisma.order.count({ where: { customerId: userId, status: { notIn: ['DELIVERED', 'CANCELLED'] } } });
    if (active > 0) {
      return res.status(409).json({ success: false, message: 'You have an order in progress. You can delete your account once it is delivered.' });
    }
    await prisma.user.update({
      where: { id: userId },
      data: { name: 'Deleted user', phone: null, email: null, googleSub: null, passwordHash: null, avatarId: null, isStudent: null, hostelBlock: null, fcmToken: null, upiId: null, kraveoCoins: 0 },
    });
    return res.json({ success: true, message: 'Your account has been deleted.' });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Could not delete the account.' });
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
    if (role === 'VENDOR') {
      if (vendorId) {
        const vendor = await prisma.vendor.findUnique({ where: { id: String(vendorId) } });
        if (!vendor) return bad('vendorId', 'That restaurant does not exist.');
        if (vendor.userId) return res.status(409).json({ success: false, field: 'vendorId', message: 'That restaurant already has an owner account.' });
      } else {
        const v = validateVendorFields(b);
        if (!v.ok) return bad(v.error.field, v.error.message);
        vendorData = v.data;
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
        const lat = typeof b.lat === 'number' ? b.lat : undefined;
        const lng = typeof b.lng === 'number' ? b.lng : undefined;
        const v = await tx.vendor.create({ data: { ...vendorData, userId: created.id, bannerImage: DEFAULT_BANNER, isAcceptingOrders: true, approvalStatus: 'APPROVED', ...(lat !== undefined ? { lat } : {}), ...(lng !== undefined ? { lng } : {}) } });
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
    return res.status(500).json({ success: false, message: err.message || 'Could not create the partner.' });
  }
});

apiRouter.get('/admin/partners', requireAuth, requireRole('ADMIN'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: { in: [Role.VENDOR, Role.DRIVER] } },
      select: { id: true, name: true, phone: true, role: true, createdAt: true, vendorsOwned: { select: { id: true, name: true, approvalStatus: true } }, driverProfile: { select: { id: true, runnerCode: true, approvalStatus: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, data: users });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Could not list partners.' });
  }
});

// Register FCM Push Notification Token
apiRouter.post('/notifications/register-token', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
      return res.status(400).json({ success: false, message: 'fcmToken is required and cannot be empty.' });
    }

    if (req.user?.id) {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { fcmToken }
      });
    }

    return res.json({ success: true, message: 'FCM push notification token registered successfully.' });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error registering token' });
  }
});

// ----------------------------------------------------
// VENDOR / DHABA ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/vendors', async (req: Request, res: Response) => {
  try {
    const viewer = optionalViewer(req);
    const dbVendors = await prisma.vendor.findMany({ include: { menuItems: true } });
    const visible = dbVendors.filter((v) => canSeeVendor(v, viewer));
    return res.json({ success: true, count: visible.length, data: visible });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching vendors' });
  }
});

apiRouter.get('/vendors/:id', async (req: Request, res: Response) => {
  try {
    const dbVendor = await prisma.vendor.findUnique({
      where: { id: req.params.id },
      include: { menuItems: true }
    });
    if (!dbVendor || !canSeeVendor(dbVendor, optionalViewer(req))) return res.status(404).json({ success: false, message: 'Vendor not found' });
    return res.json({ success: true, data: { ...dbVendor, menu: dbVendor.menuItems } });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching vendor' });
  }
});

apiRouter.post('/vendors', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, category, address, lat, lng, bannerImage } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Vendor name is required.' });
    }

    const createdVendor = await prisma.vendor.create({
      data: {
        name: name.trim(),
        category: category || 'North Indian • Campus Dhaba',
        address: address || 'Ashta Highway, near VIT Bhopal',
        lat: typeof lat === 'number' ? lat : 23.0768,
        lng: typeof lng === 'number' ? lng : 76.8524,
        bannerImage: bannerImage || 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=600',
        isAcceptingOrders: true,
      },
      include: { menuItems: true }
    });

    return res.status(201).json({ success: true, message: 'Vendor onboarded successfully', data: createdVendor });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error onboarding vendor' });
  }
});

apiRouter.patch('/vendors/:id/status', requireAuth, requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
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
    return res.status(500).json({ success: false, message: err.message || 'Error updating vendor status' });
  }
});

apiRouter.patch('/vendors/:id/toggle', requireAuth, requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
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
    return res.status(500).json({ success: false, message: err.message || 'Error toggling vendor' });
  }
});

apiRouter.post('/vendors/:id/items', requireAuth, requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, price, category, description, isVeg, imageUrl } = req.body;
    if (!name || price === undefined) {
      return res.status(400).json({ success: false, message: 'Item name and price are required.' });
    }
    if (!(await canManageVendor(req.params.id, req.user))) return res.status(403).json({ success: false, message: 'Forbidden. You do not own this vendor.' });

    const newItem = await prisma.menuItem.create({
      data: {
        vendorId: req.params.id,
        name: name.trim(),
        price: parseFloat(price.toString()),
        category: category || 'Main Course',
        description: description || '',
        isVeg: isVeg !== false,
        imageUrl: imageUrl || 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400',
        isAvailable: true,
      }
    });

    return res.status(201).json({ success: true, message: 'Menu item created successfully', data: newItem });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error creating menu item' });
  }
});

// ----------------------------------------------------
// MENU ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/menus/:vendorId', async (req: Request, res: Response) => {
  try {
    const owner = await prisma.vendor.findUnique({ where: { id: req.params.vendorId }, select: { approvalStatus: true, userId: true } });
    if (!owner || !canSeeVendor(owner, optionalViewer(req))) return res.json({ success: true, count: 0, data: [] });
    const dbItems = await prisma.menuItem.findMany({ where: { vendorId: req.params.vendorId } });
    return res.json({ success: true, count: dbItems.length, data: dbItems });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching menu items' });
  }
});

apiRouter.patch('/menus/:itemId/toggle', requireAuth, requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
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
    return res.status(500).json({ success: false, message: err.message || 'Error toggling menu item' });
  }
});

// Admin reporting is calculated from persisted orders so dashboard metrics never drift from operations.
apiRouter.get('/analytics', requireAuth, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const range = req.query.range === 'today' || req.query.range === '30d' ? req.query.range : '7d';
    const now = new Date();
    const from = new Date(now);
    if (range === 'today') from.setHours(0, 0, 0, 0);
    else from.setDate(from.getDate() - (range === '30d' ? 30 : 7));

    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: from, lte: now } },
      select: { totalAmount: true, paymentStatus: true, status: true, customerId: true, dropoffHostel: true, createdAt: true, updatedAt: true, vendor: { select: { name: true } } }
    });
    const completed = orders.filter((order) => order.status === 'DELIVERED');
    const paid = orders.filter((order) => order.paymentStatus === 'PAID');
    const vendorTotals = new Map<string, number>();
    const hostelTotals = new Map<string, number>();
    const hourlyTotals = new Map<number, number>();
    for (const order of orders) {
      if (order.status !== 'CANCELLED') {
        hostelTotals.set(order.dropoffHostel, (hostelTotals.get(order.dropoffHostel) || 0) + 1);
        const hour = order.createdAt.getHours();
        hourlyTotals.set(hour, (hourlyTotals.get(hour) || 0) + 1);
      }
      if (order.status === 'DELIVERED') vendorTotals.set(order.vendor.name, (vendorTotals.get(order.vendor.name) || 0) + 1);
    }
    const topVendor = [...vendorTotals.entries()].sort((a, b) => b[1] - a[1])[0];
    const averageDeliveryMinutes = completed.length
      ? completed.reduce((sum, order) => sum + Math.max(0, order.updatedAt.getTime() - order.createdAt.getTime()) / 60000, 0) / completed.length
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
    return res.status(500).json({ success: false, message: err.message || 'Error calculating analytics' });
  }
});

// Update Menu Item Stock Availability & Price (Prisma DB Persistence)
apiRouter.patch('/vendors/items/:itemId', requireAuth, requireRole('VENDOR', 'ADMIN'), requireApprovedPartner, async (req: AuthenticatedRequest, res: Response) => {
  const { isAvailable, price } = req.body;

  const updateData: any = {};
  if (typeof isAvailable === 'boolean') updateData.isAvailable = isAvailable;
  if (typeof price === 'number' && price > 0) updateData.price = price;

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
    return res.status(500).json({ success: false, message: err.message || 'Error updating menu item' });
  }
});

// ----------------------------------------------------
// REVIEWS & KRAVEO COIN LOYALTY REWARDS ENDPOINTS
// ----------------------------------------------------

// Submit Order & Dish Review (Earns +10 Kraveo Coins & Updates Dhaba Rating)
apiRouter.post('/reviews', requireAuth, requireRole('STUDENT'), async (req: AuthenticatedRequest, res: Response) => {
  const { orderId, driverRating, driverTags, driverNotes, dishReviews, dhabaNotes } = req.body;

  if (!orderId) {
    return res.status(400).json({ success: false, message: 'orderId is required.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw new Error('ORDER_NOT_FOUND');
      }

      if (order.customerId !== req.user?.id || order.status !== 'DELIVERED') {
        throw new Error('FORBIDDEN');
      }

      if (order.isReviewed) {
        throw new Error('ALREADY_REVIEWED');
      }

      const customerId = req.user?.id || order.customerId;

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
      if (Array.isArray(dishReviews)) {
        for (const dr of dishReviews) {
          if (dr && dr.dishId && typeof dr.rating === 'number') {
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
        }
      }

      // 4. Update Vendor Rating using Bayesian Aggregation Algorithm
      let updatedVendor = null;
      const vendor = await tx.vendor.findUnique({ where: { id: order.vendorId } });
      if (vendor) {
        const C = 10; // Prior weight constant
        const m = 4.5; // Campus baseline rating
        const currentTotalCount = vendor.totalRatingsCount || 50;
        const newTotalCount = currentTotalCount + 1;
        const ratingToUse = typeof driverRating === 'number' ? driverRating : 4.5;
        const newRatingSum = (vendor.rating * currentTotalCount) + ratingToUse;
        
        // Bayesian Weighted Average Formula
        const bayesianRating = parseFloat((((C * m) + newRatingSum) / (C + newTotalCount)).toFixed(2));
        updatedVendor = await tx.vendor.update({
          where: { id: vendor.id },
          data: { rating: bayesianRating, totalRatingsCount: newTotalCount }
        });
      }

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
          driverTags: driverTags || [],
          driverNotes: driverNotes || '',
          dishReviews: dishReviews || [],
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
      review: result.newReview
    });
  } catch (err: any) {
    if (err.message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    if (err.message === 'ALREADY_REVIEWED') {
      return res.status(400).json({ success: false, message: 'This order has already been reviewed.' });
    }
    if (err.message === 'FORBIDDEN') {
      return res.status(403).json({ success: false, message: 'Only the student who placed a delivered order can review it.' });
    }
    return res.status(500).json({ success: false, message: err.message || 'Error submitting review.' });
  }
});

// Redeem 50 Kraveo Coins for Flat ₹20 OFF Coupon
apiRouter.post('/coupons/redeem-coins', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Unauthorized' });

    // Atomic update eliminating concurrency race conditions
    const updateResult = await prisma.user.updateMany({
      where: { id: req.user.id, kraveoCoins: { gte: 50 } },
      data: { kraveoCoins: { decrement: 50 } }
    });

    if (updateResult.count === 0) {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      const currentCoins = user?.kraveoCoins || 0;
      return res.status(400).json({
        success: false,
        message: `Insufficient Kraveo Coins. You have ${currentCoins} coins, but need 50 coins to redeem ₹20 OFF.`
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
    return res.status(500).json({ success: false, message: err.message || 'Error redeeming coins' });
  }
});

// Fetch Dhaba Reviews
apiRouter.get('/reviews/vendor/:vendorId', async (req: Request, res: Response) => {
  try {
    const vendorReviews = await prisma.reviewRecord.findMany({
      where: { vendorId: req.params.vendorId },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({ success: true, count: vendorReviews.length, data: vendorReviews });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching vendor reviews' });
  }
});

// Fetch Driver Reviews
apiRouter.get('/reviews/driver/:driverId', async (req: Request, res: Response) => {
  try {
    const driverIdParam = req.params.driverId;
    const driver = await prisma.driverPartner.findFirst({
      where: { OR: [{ id: driverIdParam }, { userId: driverIdParam }] }
    });

    const targetIds = [driverIdParam];
    if (driver?.id && !targetIds.includes(driver.id)) targetIds.push(driver.id);
    if (driver?.userId && !targetIds.includes(driver.userId)) targetIds.push(driver.userId);

    const driverReviews = await prisma.reviewRecord.findMany({
      where: { driverId: { in: targetIds } },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({ success: true, count: driverReviews.length, data: driverReviews });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message || 'Error fetching driver reviews' });
  }
});
