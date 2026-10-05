import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, ah } from '../../lib/http.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import { withTenant } from '@cs/db';
import { deleteProviderCallData, eraseContact, privacyStatus, purgeTenantData } from './purge.js';
import { now } from '../../lib/util.js';
import type { Deps } from '../../types.js';

/** Privacy controls for a campaign: retention status, deleting everything after the election, and erasing one person. */
export function privacyRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  r.use(loadTenant(deps));

  r.get('/', requireRole('owner', 'manager'), ah(async (req, res) => {
    res.json(await privacyStatus(deps, req.tenant!));
  }));

  /**
   * "Delete everything now". Only for the owner, only once the election date has passed, and only with the typed confirmation:
   * this cannot be undone. (The scheduled job does the same thing automatically on the retention date.)
   */
  r.post('/purge', requireRole('owner'), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({ confirm: z.literal('DELETE') }).safeParse(req.body);
    if (!b.success) throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Type DELETE to confirm. This cannot be undone.');
    if (!t.isDemo && new Date(`${t.electionDate}T23:59:59Z`).getTime() > now(deps).getTime()) {
      throw new HttpError(409, 'ELECTION_NOT_OVER', 'Personal data can be deleted in bulk only after the election date.');
    }
    const out = await purgeTenantData(deps, t.id, { kind: 'owner_request', requestedBy: req.user!.id });
    if (out && out.alreadyPurged) throw new HttpError(409, 'ALREADY_PURGED');
    res.json(out);
  }));

  /** Retry deleting the voice provider's copy of this campaign's calls (after a purge, if some deletions failed). */
  r.post('/provider-data', requireRole('owner'), ah(async (req, res) => {
    const t = req.tenant!;
    if (!t.purgedAt) throw new HttpError(409, 'NOT_PURGED_YET', 'Provider data is deleted as part of the personal data deletion.');
    res.json(await deleteProviderCallData(deps, t.id));
  }));

  /** Erase one person (they asked to be forgotten). Their number stays only as a one-way hash on the do-not-contact list. */
  r.delete('/contacts/:contactId', requireRole('owner', 'manager'), ah(async (req, res) => {
    const t = req.tenant!;
    const id = z.string().uuid().parse(req.params.contactId);
    const counts = await withTenant(deps.pool, t.id, (db) => eraseContact(db, t, id, req.user!.id));
    if (!counts) throw new HttpError(404, 'NOT_FOUND');
    res.json({ erased: true, counts });
  }));

  return r;
}
