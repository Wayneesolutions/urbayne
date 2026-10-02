import express from 'express';
import helmet from 'helmet';
import { errorHandler } from './lib/errors.js';
import { authenticate, requireCompany, requirePasswordChanged, requireRole, requireTenantUser } from './middleware/auth.js';
import authRoutes from './routes/auth.routes.js';
import companyRoutes from './routes/company.routes.js';
import superAdminRoutes from './routes/superadmin.routes.js';
import userRoutes from './routes/users.routes.js';

export const app = express();
app.set('trust proxy', 1); // needed for correct rate-limit IPs behind nginx / a load balancer
app.use(helmet());
app.use(express.json({ limit: '100kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', authenticate, requireRole('SUPER_ADMIN'), superAdminRoutes);
app.use('/api/company', authenticate, requireTenantUser, requirePasswordChanged, companyRoutes);
app.use('/api/users', authenticate, requireTenantUser, requirePasswordChanged, requireCompany, userRoutes);

// New election modules go here with the same guard chain, e.g.:
// app.use('/api/voters', authenticate, requireTenantUser, requirePasswordChanged, requireCompany, voterRoutes);
// and inside: requirePermission('voters:read') + every query filtered by req.auth.companyId.

app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
app.use(errorHandler);
