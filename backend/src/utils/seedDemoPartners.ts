/**
 * Creates (or resets the password of) one demo VENDOR and one demo DRIVER for testing/demos.
 * Usage: node dist/utils/seedDemoPartners.js /path/to/output.txt
 * The generated passwords are written ONLY to the output file (mode 600) - never to stdout.
 */
import { randomBytes } from 'crypto';
import { writeFileSync, chmodSync } from 'fs';
import { Role } from '@prisma/client';
import { prisma } from '../db';
import { hashPassword } from '../services/password';

const newPassword = () => randomBytes(9).toString('base64').replace(/[+/=]/g, 'x').slice(0, 12);

const upsertPartner = async (phone: string, name: string, role: Role, password: string) => {
  const passwordHash = await hashPassword(password);
  const existing = await prisma.user.findFirst({ where: { phone: { endsWith: phone.slice(-10) } } });
  if (existing) {
    if (existing.role !== role) throw new Error(`${phone} already belongs to a ${existing.role}.`);
    return prisma.user.update({ where: { id: existing.id }, data: { passwordHash, name } });
  }
  return prisma.user.create({ data: { phone, name, role, passwordHash } });
};

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('Pass an output file path as the first argument.');

  const vendorPassword = newPassword();
  const driverPassword = newPassword();

  const vendorUser = await upsertPartner('+91 9000000101', 'Ram Singh (Demo Vendor)', Role.VENDOR, vendorPassword);
  const vendor =
    (await prisma.vendor.findFirst({ where: { userId: vendorUser.id } })) ??
    (await prisma.vendor.findFirst({ where: { userId: null }, orderBy: { createdAt: 'asc' } }));
  if (vendor && vendor.userId !== vendorUser.id) await prisma.vendor.update({ where: { id: vendor.id }, data: { userId: vendorUser.id } });

  const driverUser = await upsertPartner('+91 9000000102', 'Vikram Singh (Demo Driver)', Role.DRIVER, driverPassword);
  const existingProfile = await prisma.driverPartner.findFirst({ where: { userId: driverUser.id } });
  if (!existingProfile) {
    await prisma.driverPartner.create({
      data: {
        userId: driverUser.id,
        name: 'Vikram Singh (Demo Driver)',
        phone: '+91 9000000102',
        studentRegNo: 'N/A',
        runnerCode: 'RUN-0102',
        avatarUrl: '',
        vehicleType: 'Scooter',
        vehicleRegNo: 'MP04 DEMO 0102',
        emergencyPhone: '+91 9000000102',
      },
    });
  }

  const text = [
    '# Kraveo DEMO partner accounts (local only - never commit, never share)',
    '',
    `Vendor app  -> phone: 9000000101   password: ${vendorPassword}   (restaurant: ${vendor?.name ?? 'none linked'})`,
    `Driver app  -> phone: 9000000102   password: ${driverPassword}   (runner code: RUN-0102)`,
    '',
    'Re-run the seed script to reset these passwords.',
    '',
  ].join('\n');
  writeFileSync(out, text, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`Demo partners ready. Credentials written to ${out}`);
}

main()
  .catch((err) => {
    console.error('seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
