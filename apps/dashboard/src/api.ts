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
  // A password someone else chose must be replaced before anything else works.
  if (res.status === 403 && body?.error === 'PASSWORD_CHANGE_REQUIRED' && !location.pathname.endsWith('/change-password')) location.assign('/admin/change-password');
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

/** Sends a file as the request body (receipts, bank statements, roll copies, recordings). */
export async function upload<T = any>(path: string, file: Blob, name = 'file', method = 'POST', retried = false): Promise<T> {
  const res = await fetch(`/api${path}`, { method, headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(name), ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) }, body: file });
  if (res.status === 401 && !retried && (await refresh())) return upload(path, file, name, method, true);
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, body?.error ?? 'ERROR', body?.message ?? body?.error ?? res.statusText, body);
  return body as T;
}

/** Fetches a protected file (needs the sign-in header, so a plain link cannot) and opens or saves it. */
export async function fetchFile(path: string, save?: string) {
  const res = await api<Response>(path, { raw: true });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new ApiError(res.status, j?.error ?? 'ERROR', j?.message ?? res.statusText, j); }
  const url = URL.createObjectURL(await res.blob());
  if (save) { const a = document.createElement('a'); a.href = url; a.download = save; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000); }
  else { window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
}

export const errText = (x: unknown, fallback = 'Something went wrong.') => (x instanceof ApiError ? x.message : fallback);
