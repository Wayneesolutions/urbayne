import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams, Outlet } from 'react-router-dom';
import { api, session } from './api';
import { Login } from './pages/Login';
import { ChangePassword, ForgotPassword, ResetPassword } from './pages/PasswordPages';
import { SuperAdmin } from './pages/SuperAdmin';
import { Overview } from './pages/Overview';
import { Content } from './pages/Content';
import { Contacts } from './pages/Contacts';
import { Calls, RunDetail } from './pages/Calls';
import { Share } from './pages/Share';
import { Assistant } from './pages/Assistant';
import { Team } from './pages/Team';
import { Field } from './pages/Field';
import { Events } from './pages/Events';
import { Signs } from './pages/Signs';
import { Finance } from './pages/Finance';
import { Service } from './pages/Service';
import { ServiceReports } from './pages/ServiceReports';
import { ServiceSetup } from './pages/ServiceSetup';
import { Results } from './pages/Results';
import { Pack } from './pages/Pack';
import { Billing } from './pages/Billing';
import { Agency } from './pages/Agency';
import { Platform } from './pages/Platform';

export interface Tenant { kind?: 'campaign' | 'office'; serviceSlaDays?: number; ticketRetentionDays?: number | null; id: string; region: 'IN' | 'CA'; campaignName: string; candidateName?: string; slug?: string; isDemo: boolean; seatCode: string; electionDate: string; pollCloseAt?: string; timeZone: string }

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/change-password" element={<RequireAuth><ChangePassword /></RequireAuth>} />
      <Route path="/superadmin" element={<RequireAuth><SuperAdmin /></RequireAuth>} />
      <Route path="/" element={<RequireAuth><CampaignPicker /></RequireAuth>} />
      <Route path="/platform" element={<RequireAuth><Platform /></RequireAuth>} />
      <Route path="/agency/:agencyId" element={<RequireAuth><Agency /></RequireAuth>} />
      <Route path="/c/:tenantId" element={<RequireAuth><Shell /></RequireAuth>}>
        <Route index element={<Overview />} />
        <Route path="content" element={<Content />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="calls" element={<Calls />} />
        <Route path="calls/:runId" element={<RunDetail />} />
        <Route path="share" element={<Share />} />
        <Route path="assistant" element={<Assistant />} />
        <Route path="team" element={<Team />} />
        <Route path="field" element={<Field />} />
        <Route path="events" element={<Events />} />
        <Route path="signs" element={<Signs />} />
        <Route path="finance" element={<Finance />} />
        <Route path="results" element={<Results />} />
        <Route path="service" element={<Service />} />
        <Route path="service/reports" element={<ServiceReports />} />
        <Route path="service/setup" element={<ServiceSetup />} />
        <Route path="checklist" element={<Pack />} />
        <Route path="billing" element={<Billing />} />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

function RequireAuth({ children }: { children: JSX.Element }) {
  return session.token ? children : <Navigate to="/login" replace />;
}

function CampaignPicker() {
  const [list, setList] = useState<{ tenant_id: string; campaign_name: string; region: string; role: string }[] | null>(null);
  const [isStaff, setIsStaff] = useState(false);
  const [isSuper, setIsSuper] = useState(false);
  const [agencies, setAgencies] = useState<{ id: string; name: string; brandName: string | null; role: string }[]>([]);
  const nav = useNavigate();
  useEffect(() => {
    Promise.all([api('/auth/me'), api('/agencies/mine').catch(() => [])]).then(([m, ag]) => {
      setList(m.campaigns); setAgencies(ag); setIsStaff(Boolean(m.user?.wes)); setIsSuper(Boolean(m.user?.isSuperAdmin));
      if (m.campaigns.length === 1 && !ag.length) nav(`/c/${m.campaigns[0].tenant_id}`, { replace: true });
      if (!m.campaigns.length && ag.length === 1) nav(`/agency/${ag[0].id}`, { replace: true });
    });
  }, [nav]);
  if (!list) return <div className="centered muted">Loading…</div>;
  return (
    <div className="centered">
      <div className="panel narrow">
        <h1>Your campaigns</h1>
        {list.length === 0 && agencies.length === 0 && <p className="muted">You are not part of a campaign yet. Ask the campaign owner for an invite.</p>}
        {isSuper && <p><Link className="btn" to="/superadmin">Super admin: accounts</Link></p>}
        {isStaff && <p><Link className="btn" to="/platform">Packages and pricing (platform staff)</Link></p>}
        {agencies.length > 0 && <><h2 className="small muted">Your agency</h2><ul className="picker">{agencies.map((a) => <li key={a.id}><button onClick={() => nav(`/agency/${a.id}`)}><strong>{a.brandName ?? a.name}</strong><span className="muted">All campaigns · {a.role}</span></button></li>)}</ul></>}
        <ul className="picker">{list.map((c) => (
          <li key={c.tenant_id}><button onClick={() => nav(`/c/${c.tenant_id}`)}><strong>{c.campaign_name}</strong><span className="muted">{c.region === 'IN' ? 'India' : 'Canada'} · {c.role}</span></button></li>
        ))}</ul>
      </div>
    </div>
  );
}

export type ShellCtx = { tenant: Tenant; role: string; reload: () => void };

function Shell() {
  const { tenantId } = useParams();
  const [ctx, setCtx] = useState<{ tenant: Tenant; role: string } | null>(null);
  const [brand, setBrand] = useState<{ brandName: string; primaryColor: string | null; supportEmail: string | null } | null>(null);
  const nav = useNavigate();
  const load = () => api(`/tenants/${tenantId}`).then(setCtx).catch(() => nav('/'));
  useEffect(() => { load(); api(`/t/${tenantId}/agency/branding`).then((b) => setBrand(b.agency)).catch(() => setBrand(null)); }, [tenantId]);
  if (!ctx) return <div className="centered muted">Loading…</div>;
  const t = ctx.tenant;
  const link = (to: string, label: string) => <NavLink end={to === ''} to={`/c/${t.id}/${to}`}>{label}</NavLink>;
  return (
    <div className="shell">
      <aside className="side">
        <div className="side-top">
          <strong className="camp">{t.candidateName ?? t.campaignName}</strong>
          <span className="side-meta">{t.region === 'IN' ? 'India' : 'Canada'} · {t.seatCode}</span>
          {t.isDemo && <span className="demo-pill">Demo campaign</span>}
        </div>
        <nav>
          {link('', 'Overview')}
          {link('content', 'Content & approvals')}
          {link('contacts', 'Contacts')}
          {link('calls', 'Calls & surveys')}
          {link('share', 'Share links')}
          {link('assistant', 'Assistant questions')}
          {(ctx.role === 'owner' || ctx.role === 'manager' || ctx.role === 'coordinator') && <>
            <span className="nav-group">Election day</span>
            {link('results', 'Poll day and counting')}
          </>}
          {(ctx.role === 'owner' || ctx.role === 'manager' || ctx.role === 'service_staff') && <>
            <span className="nav-group">Constituent service</span>
            {link('service', 'Requests')}
            {link('service/reports', 'Service reports')}
            {link('service/setup', 'Service setup')}
          </>}
          <span className="nav-group">Ground game</span>
          {link('field', t.region === 'IN' ? 'Booth workers' : 'Door-to-door')}
          {link('events', 'Events & volunteers')}
          {t.region === 'CA' && link('signs', 'Lawn signs')}
          <span className="nav-group">Money and team</span>
          {link('finance', t.region === 'IN' ? 'Expenditure' : 'Finance')}
          {link('team', 'Team')}
          {(ctx.role === 'owner' || ctx.role === 'manager') && <>
            <span className="nav-group">Setup</span>
            {link('checklist', 'Election checklist')}
            {link('billing', 'Package and usage')}
          </>}
        </nav>
        {brand?.supportEmail && <a className="side-meta" href={`mailto:${brand.supportEmail}`}>Help: {brand.supportEmail}</a>}
        <Link className="side-meta" to="/change-password">Change password</Link>
        <button className="linklike side-out" onClick={() => { session.clear(); nav('/login'); }}>Sign out</button>
      </aside>
      <main className="work"><Outlet context={{ ...ctx, reload: load } satisfies ShellCtx} /></main>
    </div>
  );
}
