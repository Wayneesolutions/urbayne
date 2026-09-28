import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { getRegion, type CallingHours, type Locale } from '@cs/regions';
import { checkOutbound } from '@cs/compliance';
import { HttpError, ah } from '../lib/http.js';
import { loadTenant } from '../middleware/auth.js';
import type { Deps } from '../types.js';

/** Dry-run the compliance engine for a planned send. Workers call the same engine before every real send. */
export function complianceRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  r.use(loadTenant(deps));

  r.post('/check', ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({
      contentItemId: z.string().uuid(),
      contactId: z.string().uuid().optional(),
      channel: z.enum(['voice', 'sms', 'ai_answer']),
      purpose: z.enum(['info', 'survey', 'reminder', 'donation']),
      sendAt: z.string().datetime({ offset: true }).optional(),
      scope: z.enum(['run', 'send']).default('send'),
    }).parse(req.body);

    const result = await withTenant(deps.pool, t.id, async (db) => {
      const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, b.contentItemId));
      if (!item) throw new HttpError(404, 'CONTENT_NOT_FOUND');
      let contact;
      if (b.contactId) {
        const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, b.contactId));
        if (!c) throw new HttpError(404, 'CONTACT_NOT_FOUND');
        const cs = await db.select().from(schema.consents).where(eq(schema.consents.contactId, c.id));
        contact = { id: c.id, timeZone: c.timeZone, optedOut: c.optedOut, consents: cs.map((x) => ({ purpose: x.purpose, channel: x.channel, withdrawnAt: x.withdrawnAt })) };
      }
      return checkOutbound({
        region: getRegion(t.region),
        tenant: {
          id: t.id,
          campaignName: t.campaignName,
          timeZone: t.timeZone,
          pollCloseAt: t.pollCloseAt,
          callingHoursOverride: (t.callingHoursOverride as CallingHours | null) ?? null,
        },
        channel: b.channel,
        purpose: b.purpose,
        sendAt: b.sendAt ? new Date(b.sendAt) : (deps.now ? deps.now() : new Date()),
        scope: b.scope,
        contentItem: {
          id: item.id, kind: item.kind, locale: item.locale as Locale, body: item.body,
          status: item.status, certificateNo: item.certificateNo, dltTemplateId: item.dltTemplateId,
        },
        contact,
        spendLimitMinor: t.spendLimitMinor,
      });
    });
    res.json(result);
  }));

  return r;
}
