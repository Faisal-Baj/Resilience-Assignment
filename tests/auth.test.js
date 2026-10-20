// Tests 1-4: signing in, bad tokens, logout and disabled users.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { SignJWT, UnsecuredJWT } from 'jose';
import { app, prisma, config, PASSWORD, createTestData, signIn, get, post } from './helpers.js';

let users;

beforeEach(async () => {
  ({ users } = await createTestData());
});

afterAll(async () => {
  await prisma.$disconnect();
});

function login(email, password) {
  return request(app).post('/api/auth/login').set('Origin', config.appOrigin).send({ email, password });
}

describe('1. Login and an authenticated request', () => {
  it('signs in and then loads the user from the database', async () => {
    // Mixed case on purpose: emails are not case-sensitive at sign-in.
    const res = await login('MemberA@Test.Local', PASSWORD);

    expect(res.status).toBe(204);
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/); // page JavaScript can't read the token
    expect(cookie).toMatch(/SameSite=Strict/); // not sent on requests from other websites

    const me = await get(cookie.split(';')[0], '/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual({
      id: users.memberA.id,
      name: 'memberA',
      role: 'MEMBER',
      organizationId: users.memberA.organizationId,
      organizationName: 'Org A',
    });
  });

  it('rejects a request without a token', async () => {
    const res = await request(app).get('/api/items');
    expect(res.status).toBe(401);
  });
});

describe('2. Invalid credentials and invalid tokens', () => {
  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await login(users.memberA.email, 'not-the-password');
    const unknownEmail = await login('nobody@test.local', PASSWORD);

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual({ error: 'Invalid email or password.' });
    expect(unknownEmail.body).toEqual(wrongPassword.body); // nothing reveals which accounts exist
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  describe('tokens', () => {
    let sessionId;

    beforeEach(async () => {
      await signIn(users.memberA); // creates a real session row
      sessionId = (await prisma.session.findFirstOrThrow({ where: { userId: users.memberA.id } })).id;
    });

    // Makes a token for memberA's real session. Each test changes one thing, so if the request
    // fails, we know it failed because of that one thing.
    function makeToken({
      subject = users.memberA.id,
      issuer = config.jwtIssuer,
      audience = config.jwtAudience,
      expiresAt = '15m',
      secret = config.jwtSecret,
    } = {}) {
      return new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(subject)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .sign(secret);
    }

    async function statusWithToken(token) {
      const res = await get(`access_token=${token}`, '/api/auth/me');
      return res.status;
    }

    it('accepts a correctly made token (this proves the tests below fail for the right reason)', async () => {
      expect(await statusWithToken(await makeToken())).toBe(200);
    });

    it('rejects a malformed token', async () => {
      expect(await statusWithToken('this-is-not-a-jwt')).toBe(401);
    });

    it('rejects a tampered token (the payload was changed after signing)', async () => {
      const [header, payload, signature] = (await makeToken()).split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      // Make the token last a day longer. Everything else stays valid, so only the signature check can catch this.
      claims.exp += 24 * 60 * 60;
      const tamperedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');

      expect(await statusWithToken(`${header}.${tamperedPayload}.${signature}`)).toBe(401);
    });

    it('rejects a token signed with a different secret', async () => {
      const otherSecret = new TextEncoder().encode('a-different-secret-that-is-long-enough!!');
      expect(await statusWithToken(await makeToken({ secret: otherSecret }))).toBe(401);
    });

    it('rejects an unsigned token (alg: none)', async () => {
      const token = new UnsecuredJWT({ sid: sessionId })
        .setSubject(users.memberA.id)
        .setIssuer(config.jwtIssuer)
        .setAudience(config.jwtAudience)
        .setExpirationTime('15m')
        .encode();
      expect(await statusWithToken(token)).toBe(401);
    });

    it('rejects an expired token', async () => {
      const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60;
      expect(await statusWithToken(await makeToken({ expiresAt: oneMinuteAgo }))).toBe(401);
    });

    it('rejects a token with the wrong issuer', async () => {
      expect(await statusWithToken(await makeToken({ issuer: 'someone-else' }))).toBe(401);
    });

    it('rejects a token with the wrong audience', async () => {
      expect(await statusWithToken(await makeToken({ audience: 'another-app' }))).toBe(401);
    });
  });
});

describe('3. Logout', () => {
  it('deletes the session, so a saved copy of the old token stops working', async () => {
    const cookie = await signIn(users.memberA);
    expect((await get(cookie, '/api/auth/me')).status).toBe(200);

    const res = await post(cookie, '/api/auth/logout');

    expect(res.status).toBe(204);
    expect(await prisma.session.count({ where: { userId: users.memberA.id } })).toBe(0);
    expect((await get(cookie, '/api/auth/me')).status).toBe(401); // same token as before
  });
});

describe('4. Disabled user', () => {
  it('is locked out on the next request and cannot sign in again', async () => {
    const cookie = await signIn(users.memberA);
    expect((await get(cookie, '/api/items')).status).toBe(200);

    await prisma.user.update({ where: { id: users.memberA.id }, data: { disabled: true } });

    expect((await get(cookie, '/api/items')).status).toBe(401); // the token itself is still valid
    const res = await login(users.memberA.email, PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid email or password.' }); // doesn't say "disabled"
  });
});
