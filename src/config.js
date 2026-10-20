// Reads the settings from .env when the server starts. If a required one is missing, the server won't start.
import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters long');

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL'),
  appOrigin: process.env.APP_ORIGIN || 'http://localhost:3000',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  appTimezone: process.env.APP_TIMEZONE || 'Asia/Riyadh',

  // Login tokens (JWT)
  jwtSecret: new TextEncoder().encode(jwtSecret),
  jwtIssuer: 'remediation-workspace-api',
  jwtAudience: 'remediation-workspace-web',
  tokenMinutes: 15,
};
