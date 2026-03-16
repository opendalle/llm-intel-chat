-- ============================================================
-- NEXUS ASIA CRE INTELLIGENCE PLATFORM
-- Supabase / PostgreSQL Schema
-- Run this entire file in your Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE: companies
-- ============================================================
CREATE TABLE IF NOT EXISTS companies (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  city          TEXT,
  industry      TEXT,
  sector        TEXT,
  website       TEXT,
  employees     INTEGER,
  revenue_cr    NUMERIC,         -- Revenue in Crores INR
  listed        BOOLEAN DEFAULT FALSE,
  cin           TEXT UNIQUE,     -- Corporate Identification Number (India)
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_name ON companies (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_companies_city ON companies (city);

-- ============================================================
-- TABLE: buildings
-- ============================================================
CREATE TABLE IF NOT EXISTS buildings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  building_name   TEXT NOT NULL,
  city            TEXT NOT NULL,
  micro_market    TEXT,           -- e.g. BKC, Whitefield, Cyber City
  owner           TEXT,
  developer       TEXT,
  total_area      NUMERIC,        -- sq ft
  grade           TEXT,           -- A, A+, B
  completion_year INTEGER,
  occupancy_pct   NUMERIC,        -- 0–100
  address         TEXT,
  latitude        NUMERIC,
  longitude       NUMERIC,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buildings_city ON buildings (city);
CREATE INDEX IF NOT EXISTS idx_buildings_name ON buildings (LOWER(building_name));

-- ============================================================
-- TABLE: leases
-- ============================================================
CREATE TABLE IF NOT EXISTS leases (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant          TEXT NOT NULL,
  building_name   TEXT NOT NULL,
  city            TEXT,
  floor           TEXT,
  area            NUMERIC,        -- sq ft
  rent            NUMERIC,        -- INR per sq ft per month
  total_monthly   NUMERIC GENERATED ALWAYS AS (area * rent) STORED,
  lease_start     DATE,
  lease_expiry    DATE,
  lock_in_period  INTEGER,        -- months
  notice_period   INTEGER,        -- months
  status          TEXT DEFAULT 'active', -- active | expired | surrendered
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leases_tenant ON leases (LOWER(tenant));
CREATE INDEX IF NOT EXISTS idx_leases_building ON leases (LOWER(building_name));
CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases (lease_expiry);
CREATE INDEX IF NOT EXISTS idx_leases_city ON leases (city);

-- ============================================================
-- TABLE: distress_events
-- ============================================================
CREATE TABLE IF NOT EXISTS distress_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company         TEXT NOT NULL,
  signal          TEXT NOT NULL,  -- insolvency | liquidation | sarfaesi | restructuring | winding_up | default
  severity        TEXT DEFAULT 'medium', -- low | medium | high | critical
  source          TEXT,           -- nclt | ibbi | mca | news | sarfaesi
  url             TEXT,
  headline        TEXT,
  details         TEXT,
  confidence      NUMERIC DEFAULT 0.8,  -- 0.0 – 1.0
  detected_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_distress_company ON distress_events (LOWER(company));
CREATE INDEX IF NOT EXISTS idx_distress_signal ON distress_events (signal);
CREATE INDEX IF NOT EXISTS idx_distress_detected ON distress_events (detected_at DESC);

-- ============================================================
-- TABLE: demand_signals
-- ============================================================
CREATE TABLE IF NOT EXISTS demand_signals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company         TEXT NOT NULL,
  signal          TEXT NOT NULL,  -- fundraising | hiring | new_office | expansion | relocation | acquisition
  city            TEXT,
  sqft_needed     NUMERIC,        -- estimated sq ft need if available
  confidence      NUMERIC DEFAULT 0.8,
  source          TEXT,
  url             TEXT,
  headline        TEXT,
  details         TEXT,
  detected_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_demand_company ON demand_signals (LOWER(company));
CREATE INDEX IF NOT EXISTS idx_demand_city ON demand_signals (city);
CREATE INDEX IF NOT EXISTS idx_demand_signal ON demand_signals (signal);
CREATE INDEX IF NOT EXISTS idx_demand_detected ON demand_signals (detected_at DESC);

-- ============================================================
-- TABLE: datasets  (registry of user-imported Excel/CSV tables)
-- ============================================================
CREATE TABLE IF NOT EXISTS datasets (
  dataset_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dataset_name    TEXT NOT NULL,
  table_name      TEXT NOT NULL UNIQUE,  -- actual Supabase table name
  columns         JSONB,                 -- [{"name":"col","type":"text"}, ...]
  row_count       INTEGER DEFAULT 0,
  description     TEXT,
  source_file     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE: knowledge_graph_edges
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_graph_edges (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_a        TEXT NOT NULL,
  entity_a_type   TEXT NOT NULL,  -- company | building | lender | person | signal
  entity_b        TEXT NOT NULL,
  entity_b_type   TEXT NOT NULL,
  relationship    TEXT NOT NULL,  -- occupies | owns | finances | shows_distress | shows_expansion | leases_to
  source          TEXT,
  weight          NUMERIC DEFAULT 1.0,
  metadata        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kg_entity_a ON knowledge_graph_edges (LOWER(entity_a));
CREATE INDEX IF NOT EXISTS idx_kg_entity_b ON knowledge_graph_edges (LOWER(entity_b));
CREATE INDEX IF NOT EXISTS idx_kg_relationship ON knowledge_graph_edges (relationship);

-- ============================================================
-- VIEW: lease_risk_dashboard
-- Tenants with lease expiry within 12 months AND distress signals
-- ============================================================
CREATE OR REPLACE VIEW lease_risk_dashboard AS
SELECT
  l.tenant,
  l.building_name,
  l.city,
  l.area,
  l.lease_expiry,
  l.total_monthly,
  CASE
    WHEN l.lease_expiry <= NOW() + INTERVAL '3 months'  THEN 'CRITICAL'
    WHEN l.lease_expiry <= NOW() + INTERVAL '6 months'  THEN 'HIGH'
    WHEN l.lease_expiry <= NOW() + INTERVAL '12 months' THEN 'MEDIUM'
    ELSE 'LOW'
  END AS expiry_risk,
  d.signal AS distress_signal,
  d.severity AS distress_severity
FROM leases l
LEFT JOIN distress_events d ON LOWER(l.tenant) = LOWER(d.company)
WHERE l.status = 'active'
ORDER BY l.lease_expiry ASC;

-- ============================================================
-- VIEW: building_distress_exposure
-- Buildings with tenants that have active distress signals
-- ============================================================
CREATE OR REPLACE VIEW building_distress_exposure AS
SELECT
  l.building_name,
  l.city,
  COUNT(DISTINCT l.tenant) AS total_tenants,
  COUNT(DISTINCT de.company) AS distressed_tenants,
  SUM(CASE WHEN de.company IS NOT NULL THEN l.area ELSE 0 END) AS exposed_sqft,
  SUM(CASE WHEN de.company IS NOT NULL THEN l.total_monthly ELSE 0 END) AS exposed_monthly_rent
FROM leases l
LEFT JOIN distress_events de ON LOWER(l.tenant) = LOWER(de.company)
WHERE l.status = 'active'
GROUP BY l.building_name, l.city
HAVING COUNT(DISTINCT de.company) > 0
ORDER BY distressed_tenants DESC, exposed_sqft DESC;

-- ============================================================
-- FUNCTION: auto_insert_kg_edge_on_distress
-- Automatically creates knowledge graph edges when a distress
-- event is inserted (company → distress_signal)
-- ============================================================
CREATE OR REPLACE FUNCTION fn_auto_kg_distress()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO knowledge_graph_edges (entity_a, entity_a_type, entity_b, entity_b_type, relationship, source, metadata)
  VALUES (
    NEW.company,
    'company',
    NEW.signal,
    'signal',
    'shows_distress',
    NEW.source,
    jsonb_build_object('url', NEW.url, 'detected_at', NEW.detected_at, 'severity', NEW.severity)
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_distress_kg
AFTER INSERT ON distress_events
FOR EACH ROW EXECUTE FUNCTION fn_auto_kg_distress();

-- ============================================================
-- FUNCTION: auto_insert_kg_edge_on_demand
-- Automatically creates knowledge graph edges for demand signals
-- ============================================================
CREATE OR REPLACE FUNCTION fn_auto_kg_demand()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO knowledge_graph_edges (entity_a, entity_a_type, entity_b, entity_b_type, relationship, source, metadata)
  VALUES (
    NEW.company,
    'company',
    NEW.signal,
    'signal',
    'shows_expansion',
    NEW.source,
    jsonb_build_object('url', NEW.url, 'detected_at', NEW.detected_at, 'city', NEW.city)
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_demand_kg
AFTER INSERT ON demand_signals
FOR EACH ROW EXECUTE FUNCTION fn_auto_kg_demand();

-- ============================================================
-- FUNCTION: auto_insert_kg_edge_on_lease
-- Creates building ↔ company edges when a lease is inserted
-- ============================================================
CREATE OR REPLACE FUNCTION fn_auto_kg_lease()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO knowledge_graph_edges (entity_a, entity_a_type, entity_b, entity_b_type, relationship, source, metadata)
  VALUES (
    NEW.tenant,
    'company',
    NEW.building_name,
    'building',
    'occupies',
    'lease_import',
    jsonb_build_object('area', NEW.area, 'expiry', NEW.lease_expiry, 'city', NEW.city)
  )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lease_kg
AFTER INSERT ON leases
FOR EACH ROW EXECUTE FUNCTION fn_auto_kg_lease();

-- ============================================================
-- ROW LEVEL SECURITY (to enable for production)
-- Uncomment these lines after configuring your auth policies
-- ============================================================
-- ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE leases ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE distress_events ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE demand_signals ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE datasets ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE knowledge_graph_edges ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- SEED DATA (sample records for immediate testing)
-- ============================================================

-- Sample companies
INSERT INTO companies (name, city, industry, sector) VALUES
  ('ABC Technologies Ltd',  'Mumbai',    'IT Services',       'Technology'),
  ('XYZ Pharma Pvt Ltd',    'Pune',      'Pharmaceuticals',   'Healthcare'),
  ('Fintech Capital Pvt', 'Bangalore', 'Fintech',            'Finance'),
  ('Retail Chain Co',       'Hyderabad', 'Retail',            'Consumer'),
  ('Infra Build Corp',      'Delhi',     'Infrastructure',    'Real Estate')
ON CONFLICT DO NOTHING;

-- Sample buildings
INSERT INTO buildings (building_name, city, micro_market, owner, total_area, grade) VALUES
  ('Bandra Kurla One',   'Mumbai',    'BKC',        'Brookfield',    800000, 'A+'),
  ('Magarpatta Cybercity','Pune',    'Hadapsar',   'Magarpatta',    1200000,'A'),
  ('RMZ Infinity',       'Bangalore', 'Whitefield', 'RMZ Corp',      600000, 'A+'),
  ('Hitec City Tower',   'Hyderabad', 'Hitech City','L&T Realty',   900000, 'A'),
  ('Worldmark Aerocity', 'Delhi',     'Aerocity',   'Bharti Realty', 750000, 'A+')
ON CONFLICT DO NOTHING;

-- Sample leases
INSERT INTO leases (tenant, building_name, city, area, rent, lease_start, lease_expiry) VALUES
  ('ABC Technologies Ltd',  'Bandra Kurla One',    'Mumbai',    25000, 220, '2022-01-01', '2026-12-31'),
  ('XYZ Pharma Pvt Ltd',    'Magarpatta Cybercity','Pune',      12000, 110, '2021-06-01', '2026-05-31'),
  ('Fintech Capital Pvt', 'RMZ Infinity',        'Bangalore', 18000, 140, '2023-03-01', '2028-02-28'),
  ('Retail Chain Co',       'Hitec City Tower',    'Hyderabad', 30000, 95,  '2020-09-01', '2025-08-31'),
  ('Infra Build Corp',      'Worldmark Aerocity',  'Delhi',     15000, 160, '2022-11-01', '2027-10-31')
ON CONFLICT DO NOTHING;

-- Sample distress events
INSERT INTO distress_events (company, signal, severity, source, headline, confidence) VALUES
  ('Retail Chain Co',   'insolvency',    'high',   'nclt', 'Retail Chain Co admitted for insolvency proceedings at NCLT Mumbai', 0.92),
  ('XYZ Pharma Pvt Ltd','debt_restructuring','medium','news','XYZ Pharma restructures Rs 800 Cr debt with consortium of lenders', 0.78)
ON CONFLICT DO NOTHING;

-- Sample demand signals
INSERT INTO demand_signals (company, signal, city, confidence, source, headline) VALUES
  ('Fintech Capital Pvt', 'fundraising',  'Bangalore', 0.95, 'economic_times', 'Fintech Capital raises $120M Series C, plans to triple headcount'),
  ('ABC Technologies Ltd', 'hiring',       'Mumbai',   0.85, 'linkedin',       'ABC Technologies posts 500+ jobs in Mumbai, expanding operations')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE companies IS 'Master registry of companies tracked by the intelligence platform';
COMMENT ON TABLE buildings IS 'Commercial real estate buildings database';
COMMENT ON TABLE leases IS 'Tenant lease records linking companies to buildings';
COMMENT ON TABLE distress_events IS 'Detected distress signals from NCLT, IBBI, news and other sources';
COMMENT ON TABLE demand_signals IS 'Corporate expansion and demand signals for office space';
COMMENT ON TABLE datasets IS 'Registry of user-imported Excel/CSV datasets';
COMMENT ON TABLE knowledge_graph_edges IS 'Graph edges linking companies, buildings, signals, and lenders';
