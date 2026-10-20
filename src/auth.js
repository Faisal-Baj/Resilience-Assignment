// Login, logout and requireAuth (the check every protected route uses).
//
// How a session works:
// 1. Login checks the password with argon2 and adds a row to the Session table.
// 2. The browser gets a signed token (a JWT that lasts 15 minutes) in an HttpOnly cookie.
//    The token only holds the user id (sub) and the session id (sid).
// 3. On every request, requireAuth checks the token, then checks that the session row still exists.
// 4. After 15 minutes the token expires and the user has to sign in again.
// 5. Logout deletes the session row, so the token stops working right away, even if someone copied it.
import express from 'express';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from './db.js';
import { config } from './config.js';
import { HttpError } from './errors.js';

export const authRouter = express.Router();

const COOKIE_NAME = 'access_token';
const cookieOptions = {
  httpOnly: true, // JavaScript on the page can't read it, so an XSS bug can't steal the token
  sameSite: 'strict', // not sent on requests that start from other websites (stops CSRF)
  secure: config.cookieSecure, // only sent over HTTPS when turned on (off for localhost)
  path: '/api', // only sent to the API
};

// A fake hash to check against when the email doesn't exist. Then a wrong email and a wrong
// password take the same time, so nobody can tell which emails have an account.
const DUMMY_PASSWORD_HASH = await argon2.hash('not-a-real-password');

// Returns the session and its user if the request has a valid token for a session that still exists.
// Otherwise returns null.
async function findSession(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;

  let payload;
  try {
    ({ payload } = await jwtVerify(token, config.jwtSecret, {
      algorithms: ['HS256'], // only the algorithm we sign with, so "none" and every other one is rejected
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      requiredClaims: ['sub', 'sid', 'exp'],
    }));
  } catch {
    return null; // broken, tampered with, expired, or the wrong issuer/audience
  }

  const session = await prisma.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
  if (!session || session.userId !== payload.sub) return null;
  return session;
}

// Add this to every route that needs a signed-in user. It fills req.user from the database.
// Routes never trust a user id, organization id or role sent in the request.
export async function requireAuth(req, res, next) {
  const session = await findSession(req);
  if (!session) throw new HttpError(401, 'You are not signed in, or your session has expired.');

  const { id, name, role, organizationId } = session.user;
  req.user = { id, name, role, organizationId };
  next();
}

// At most 10 failed logins per IP address every 15 minutes. Successful logins don't count.
// The counts are kept in server memory.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many failed sign-in attempts. Please try again in 15 minutes.' },
});

const loginSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().max(200),
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'Enter your email and password.');
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  const passwordMatches = await argon2.verify(user?.passwordHash ?? DUMMY_PASSWORD_HASH, password);

  // Same error for a wrong email and a wrong password.
  if (!user || !passwordMatches) {
    throw new HttpError(401, 'Invalid email or password.');
  }

  const session = await prisma.session.create({ data: { userId: user.id } });
  const token = await new SignJWT({ sid: session.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt()
    .setExpirationTime(`${config.tokenMinutes}m`)
    .sign(config.jwtSecret);

  res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: config.tokenMinutes * 60 * 1000 });
  res.status(204).end();
});

authRouter.post('/logout', async (req, res) => {
  const session = await findSession(req);
  if (session) await prisma.session.deleteMany({ where: { id: session.id } });
  res.clearCookie(COOKIE_NAME, cookieOptions);
  res.status(204).end();
});

// Returns the signed-in user and their organization's name (shown in the page header).
authRouter.get('/me', requireAuth, async (req, res) => {
  const organization = await prisma.organization.findUnique({
    where: { id: req.user.organizationId },
    select: { name: true },
  });
  res.json({ user: { ...req.user, organizationName: organization.name } });
});
