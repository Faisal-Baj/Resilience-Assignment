// Fills the database with demo organizations, users and items. Run it with `npm run db:seed`.
import argon2 from 'argon2';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';

const password = process.env.SEED_PASSWORD;
if (!password || password.length < 12) {
  throw new Error('Set SEED_PASSWORD (at least 12 characters) in .env before seeding.');
}

const ORGANIZATIONS = [
  {
    name: 'Org_A',
    users: [
      { email: 'User1A@orgA.test', name: 'Faisal Said', role: 'MANAGER' },
      { email: 'User2A@orgA.test', name: 'Yousef Ali', role: 'MEMBER' },
      { email: 'User3A@orgA.test', name: 'Ahmed Fares', role: 'MEMBER' },
      { email: 'User4A@orgA.test', name: 'Omar Nasser', role: 'MANAGER' },
    ],
    // [title, assignee email, due in N days (negative = in the past), status]
    items: [
      ['Rotate leaked AWS access key', 'User1A@orgA.test', -2, 'OPEN'],
      ['Patch OpenSSL on public web servers', 'User1A@orgA.test', 5, 'IN_PROGRESS'],
      ['Enable MFA for all admin accounts', 'User1A@orgA.test', 3, 'PENDING_REVIEW'],
      ['Close unused SSH port on build server', 'User1A@orgA.test', 0, 'OPEN'],
      ['Remove inactive accounts from the VPN', 'User1A@orgA.test', 12, 'OPEN'],
      ['Upgrade Log4j in the reporting service', 'User1A@orgA.test', -20, 'CLOSED'],
      ['Remove public access from the S3 backup bucket', 'User2A@orgA.test', -5, 'IN_PROGRESS'],
      ['Renew TLS certificate for api.acme.test', 'User2A@orgA.test', 10, 'OPEN'],
      ['Fix SQL injection in the search endpoint', 'User2A@orgA.test', 1, 'PENDING_REVIEW'],
      ['Enforce minimum password length of 12', 'User2A@orgA.test', 30, 'OPEN'],
      ['Disable TLS 1.0 and 1.1 on the load balancer', 'User3A@orgA.test', 7, 'PENDING_REVIEW'],
      ['Review firewall rules for the database subnet', 'User3A@orgA.test', 14, 'OPEN'],
    ],
  },
  {
    name: 'Org_B',
    users: [
      { email: 'User1B@orgB.test', name: 'Khalid Saleh', role: 'MANAGER' },
      { email: 'User2B@orgB.test', name: 'Sami Abdullah', role: 'MEMBER' },
      { email: 'User3B@orgB.test', name: 'Rami Haddad', role: 'MANAGER' },
      { email: 'User4B@orgB.test', name: 'Hassan Qasem', role: 'MEMBER' },
    ],
    items: [
      ['Patch VPN appliance firmware', 'User2B@orgB.test', -1, 'OPEN'],
      ['Remove default admin account on the office router', 'User2B@orgB.test', 4, 'PENDING_REVIEW'],
    ],
  },
];

// The date N days from today, in the app's timezone.
function daysFromToday(days) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.appTimezone }).format(new Date());
  const date = new Date(today);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

// Delete the old data. Child tables go first because of the foreign keys.
await prisma.auditEvent.deleteMany();
await prisma.session.deleteMany();
await prisma.remediationItem.deleteMany();
await prisma.user.deleteMany();
await prisma.organization.deleteMany();

const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

for (const org of ORGANIZATIONS) {
  const organization = await prisma.organization.create({ data: { name: org.name } });

  const users = {}; // email -> user row
  for (const user of org.users) {
    // Save emails in lower case, because login lower-cases whatever the user types.
    const data = { ...user, email: user.email.toLowerCase(), organizationId: organization.id, passwordHash };
    users[user.email] = await prisma.user.create({ data });
  }

  for (const [title, assigneeEmail, dueInDays, status] of org.items) {
    const submitted = status === 'PENDING_REVIEW' || status === 'CLOSED';
    await prisma.remediationItem.create({
      data: {
        organizationId: organization.id,
        title,
        description: 'Describe the affected systems and the expected fix here.',
        assigneeId: users[assigneeEmail].id,
        dueDate: daysFromToday(dueInDays),
        status,
        completionNote: submitted ? 'Fix applied and verified.' : null,
      },
    });
  }
}

await prisma.$disconnect();
console.log('Demo data created. Every account uses SEED_PASSWORD from .env.');
