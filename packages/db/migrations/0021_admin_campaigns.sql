-- Super admin portal: every campaign with its owner and package, across campaigns (platform staff only; no personal data beyond the owner's email and name).
CREATE FUNCTION admin_campaigns()
RETURNS TABLE (id uuid, campaign_name text, candidate_name text, region text, kind text, seat_code text, election_date date, status text,
               is_demo boolean, created_at timestamptz, owner_id uuid, owner_email text, owner_name text, plan_name text, plan_status text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.campaign_name, t.candidate_name, t.region, t.kind, t.seat_code, t.election_date, t.status,
         t.is_demo, t.created_at, u.id, u.email, u.name, s.plan, s.status
  FROM tenants t
  LEFT JOIN memberships m ON m.tenant_id = t.id AND m.role = 'owner'
  LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN subscriptions s ON s.tenant_id = t.id
  ORDER BY t.created_at DESC;
$$;
REVOKE ALL ON FUNCTION admin_campaigns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_campaigns() TO cs_app;
