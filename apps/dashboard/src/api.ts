export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: unknown) { super(message); }
}

const TOKEN = 'cs.token', REFRESH = 'cs.refresh';
export const session = {
  get token() { return localStorage.getItem(TOKEN); },
  set(access: string, refresh?: string) { localStorage.setItem(TOKEN, access); if (refresh) localStorage.setItem(REFRESH, refresh); },
  clear() { localStorage.removeItem(TOKEN); localStorage.removeItem(REFRESH); },
};

async function refresh(): Promise<boolean> {
  const rt = localStorage.getItem(REFRESH);
  if (!rt) return false;
  const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
  if (!r.ok) return false;
  session.set((await r.json()).accessToken);
  return true;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: boolean } = {}, retried = false): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !retried && (await refresh())) return api(path, opts, true);
  if (opts.raw) return res as unknown as T;
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, body?.error ?? 'ERROR', body?.message ?? body?.error ?? res.statusText, body);
  return body as T;
}

/** Human wording for compliance reason codes. */
export const REASONS: Record<string, string> = {
  CONTENT_NOT_APPROVED: 'Script is not approved yet',
  CERTIFICATE_MISSING: 'MCMC certificate number missing',
  DLT_TEMPLATE_MISSING: 'DLT template id missing',
  POLL_CLOSE_NOT_SET: 'Poll close time not set',
  SILENCE_WINDOW: 'Inside the 48-hour silence period',
  CALLING_HOURS_NOT_CONFIGURED: 'Calling hours not confirmed yet',
  OUTSIDE_CALLING_HOURS: 'Outside permitted calling hours',
  CONTACT_REQUIRED: 'Unknown contact',
  OPTED_OUT: 'Person opted out',
  NO_CONSENT: 'No consent for this kind of call',
  DONATION_BLOCKED: 'Automated donation calls not allowed',
  DISCLOSURE_TEXT_MISSING_FOR_LOCALE: 'No AI disclosure text for this language',
  DISCLOSURE_MISSING: 'Script does not open with the AI disclosure',
  CAMPAIGN_NOT_IDENTIFIED: 'Campaign not named at the start of the call',
  RATE_LIMIT: 'Hourly call limit reached',
  SPEND_OVER_LIMIT: 'Would exceed the spending limit',
  SPEND_NEAR_LIMIT: 'Spending passes 90% of the limit',
};
