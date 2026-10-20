// Builds the Express app: the pages in public/ and the JSON API under /api.
// server.js starts it. The tests import it directly, without starting a server.
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { authRouter } from './auth.js';
import { itemsRouter } from './items.js';
import { errorHandler } from './errors.js';

export const app = express();

// Security headers. The Content Security Policy only lets the browser load our own scripts and styles.
// upgrade-insecure-requests is off because the app runs on plain http on localhost.
app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));

app.use(express.static(path.join(import.meta.dirname, '..', 'public'), { extensions: ['html'] }));

app.use(express.json());
app.use(cookieParser());

// Extra CSRF protection (the cookie is already SameSite=Strict).
// A request that changes data must come from one of our own pages. Browsers always send
// the Origin header on POST and PATCH, so we check it.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('Origin') !== config.appOrigin) {
    return res.status(403).json({ error: 'Request blocked: it did not come from this application.' });
  }
  next();
});

app.use('/api/auth', authRouter);
app.use('/api', itemsRouter);
app.use(errorHandler);
