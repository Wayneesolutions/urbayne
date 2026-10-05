-- P0-10: provider cost dashboard for Wayne E Solutions (all campaigns, one place).
-- Campaigns only ever see their own costs through row-level security; this narrow function is the one door past it
-- and returns totals only, never contacts, transcripts or phone numbers. The API only calls it for platform admins.
CREATE FUNCTION provider_costs(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (tenant_id uuid, campaign_name text, region text, is_demo boolean, calls bigint, cost_usd_micros bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.campaign_name, t.region, t.is_demo,
         count(i.id) FILTER (WHERE i.cost_usd_micros IS NOT NULL),
         coalesce(sum(i.cost_usd_micros), 0)::bigint
  FROM tenants t
  LEFT JOIN interactions i ON i.tenant_id = t.id AND i.started_at >= p_from AND i.started_at < p_to
  GROUP BY t.id
  ORDER BY coalesce(sum(i.cost_usd_micros), 0) DESC;
$$;
REVOKE ALL ON FUNCTION provider_costs(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provider_costs(timestamptz, timestamptz) TO cs_app;
