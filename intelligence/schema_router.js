/**
 * schema_router.js — NEXUS ASIA CRE Intelligence Platform
 * ============================================================
 * Maps user intent → relevant tables + columns.
 * Builds a minimal schema context string that is sent to the LLM
 * for SQL generation. This prevents schema leakage and keeps the
 * LLM prompt small and focused.
 */

'use strict';

const SchemaRouter = (() => {

  // ── Full schema registry ──────────────────────────────────────────────────
  // This is the SSOT for table+column definitions used by the LLM.
  // Update this whenever you add new tables (including imported datasets).
  const FULL_SCHEMA = {

    companies: {
      description: 'Master registry of companies tracked by the platform',
      columns: [
        { name: 'id',           type: 'UUID',        notes: 'primary key' },
        { name: 'name',         type: 'TEXT',        notes: 'company name' },
        { name: 'city',         type: 'TEXT',        notes: 'headquarters city' },
        { name: 'industry',     type: 'TEXT',        notes: 'industry vertical' },
        { name: 'sector',       type: 'TEXT',        notes: 'broad sector' },
        { name: 'employees',    type: 'INTEGER',     notes: 'headcount' },
        { name: 'listed',       type: 'BOOLEAN',     notes: 'publicly listed' },
      ],
    },

    buildings: {
      description: 'Commercial real estate buildings',
      columns: [
        { name: 'id',             type: 'UUID',    notes: 'primary key' },
        { name: 'building_name',  type: 'TEXT',    notes: 'name of building' },
        { name: 'city',           type: 'TEXT',    notes: 'city location' },
        { name: 'micro_market',   type: 'TEXT',    notes: 'micro market (e.g. BKC, Whitefield)' },
        { name: 'owner',          type: 'TEXT',    notes: 'building owner' },
        { name: 'developer',      type: 'TEXT',    notes: 'developer' },
        { name: 'total_area',     type: 'NUMERIC', notes: 'total GFA in sq ft' },
        { name: 'grade',          type: 'TEXT',    notes: 'A | A+ | B' },
        { name: 'occupancy_pct',  type: 'NUMERIC', notes: 'current occupancy percentage 0-100' },
      ],
    },

    leases: {
      description: 'Tenant lease records linking companies to buildings',
      columns: [
        { name: 'id',             type: 'UUID',    notes: 'primary key' },
        { name: 'tenant',         type: 'TEXT',    notes: 'tenant company name' },
        { name: 'building_name',  type: 'TEXT',    notes: 'building name' },
        { name: 'city',           type: 'TEXT',    notes: 'city' },
        { name: 'floor',          type: 'TEXT',    notes: 'floor(s) occupied' },
        { name: 'area',           type: 'NUMERIC', notes: 'leased area in sq ft' },
        { name: 'rent',           type: 'NUMERIC', notes: 'rent per sq ft per month INR' },
        { name: 'total_monthly',  type: 'NUMERIC', notes: 'total monthly rent (area × rent), computed column' },
        { name: 'lease_start',    type: 'DATE',    notes: 'start date YYYY-MM-DD' },
        { name: 'lease_expiry',   type: 'DATE',    notes: 'expiry date YYYY-MM-DD' },
        { name: 'status',         type: 'TEXT',    notes: 'active | expired | surrendered' },
      ],
    },

    distress_events: {
      description: 'Distress signals detected from NCLT, IBBI, SARFAESI, and news',
      columns: [
        { name: 'id',           type: 'UUID',        notes: 'primary key' },
        { name: 'company',      type: 'TEXT',        notes: 'company name' },
        { name: 'signal',       type: 'TEXT',        notes: 'insolvency | liquidation | sarfaesi | debt_restructuring | default | bankruptcy' },
        { name: 'severity',     type: 'TEXT',        notes: 'low | medium | high | critical' },
        { name: 'source',       type: 'TEXT',        notes: 'nclt | ibbi | mca | news' },
        { name: 'headline',     type: 'TEXT',        notes: 'news headline or case title' },
        { name: 'url',          type: 'TEXT',        notes: 'source URL' },
        { name: 'confidence',   type: 'NUMERIC',     notes: 'detection confidence 0.0-1.0' },
        { name: 'detected_at',  type: 'TIMESTAMPTZ', notes: 'when the signal was detected' },
      ],
    },

    demand_signals: {
      description: 'Corporate expansion and demand signals',
      columns: [
        { name: 'id',           type: 'UUID',        notes: 'primary key' },
        { name: 'company',      type: 'TEXT',        notes: 'company name' },
        { name: 'signal',       type: 'TEXT',        notes: 'fundraising | hiring | new_office | expansion | acquisition | relocation' },
        { name: 'city',         type: 'TEXT',        notes: 'city where expansion is happening' },
        { name: 'sqft_needed',  type: 'NUMERIC',     notes: 'estimated sqft requirement if known' },
        { name: 'confidence',   type: 'NUMERIC',     notes: 'detection confidence 0.0-1.0' },
        { name: 'source',       type: 'TEXT',        notes: 'news source' },
        { name: 'headline',     type: 'TEXT',        notes: 'article headline' },
        { name: 'detected_at',  type: 'TIMESTAMPTZ', notes: 'when the signal was detected' },
      ],
    },

    datasets: {
      description: 'Registry of user-imported Excel/CSV datasets',
      columns: [
        { name: 'dataset_id',   type: 'UUID',        notes: 'primary key' },
        { name: 'dataset_name', type: 'TEXT',        notes: 'human-friendly name' },
        { name: 'table_name',   type: 'TEXT',        notes: 'actual Supabase table name' },
        { name: 'columns',      type: 'JSONB',       notes: 'column definitions array' },
        { name: 'row_count',    type: 'INTEGER',     notes: 'number of rows imported' },
        { name: 'created_at',   type: 'TIMESTAMPTZ', notes: 'import timestamp' },
      ],
    },

    knowledge_graph_edges: {
      description: 'Graph edges linking companies, buildings, signals, and lenders',
      columns: [
        { name: 'id',            type: 'UUID',    notes: 'primary key' },
        { name: 'entity_a',      type: 'TEXT',    notes: 'source entity name' },
        { name: 'entity_a_type', type: 'TEXT',    notes: 'company | building | lender | signal' },
        { name: 'entity_b',      type: 'TEXT',    notes: 'target entity name' },
        { name: 'entity_b_type', type: 'TEXT',    notes: 'company | building | lender | signal' },
        { name: 'relationship',  type: 'TEXT',    notes: 'occupies | owns | finances | shows_distress | shows_expansion | leases_to' },
        { name: 'source',        type: 'TEXT',    notes: 'data origin' },
        { name: 'weight',        type: 'NUMERIC', notes: 'edge strength / frequency' },
      ],
    },

    // Dashboard views (read-only)
    lease_risk_dashboard: {
      description: 'View: tenants with upcoming lease expiry + distress signal status',
      columns: [
        { name: 'tenant',            type: 'TEXT',    notes: 'tenant name' },
        { name: 'building_name',     type: 'TEXT',    notes: 'building' },
        { name: 'city',              type: 'TEXT',    notes: 'city' },
        { name: 'area',              type: 'NUMERIC', notes: 'sq ft' },
        { name: 'lease_expiry',      type: 'DATE',    notes: 'expiry date' },
        { name: 'expiry_risk',       type: 'TEXT',    notes: 'CRITICAL | HIGH | MEDIUM | LOW' },
        { name: 'distress_signal',   type: 'TEXT',    notes: 'distress type if any' },
        { name: 'distress_severity', type: 'TEXT',    notes: 'severity if any' },
      ],
    },

    building_distress_exposure: {
      description: 'View: buildings with distressed tenants and exposed rent/sqft',
      columns: [
        { name: 'building_name',          type: 'TEXT',    notes: 'building name' },
        { name: 'city',                   type: 'TEXT',    notes: 'city' },
        { name: 'total_tenants',          type: 'INTEGER', notes: 'total active tenants' },
        { name: 'distressed_tenants',     type: 'INTEGER', notes: 'count of distressed tenants' },
        { name: 'exposed_sqft',           type: 'NUMERIC', notes: 'sq ft occupied by distressed tenants' },
        { name: 'exposed_monthly_rent',   type: 'NUMERIC', notes: 'monthly rent at risk' },
      ],
    },
  };

  // ── Intent → table mapping ────────────────────────────────────────────────
  const INTENT_TABLE_MAP = {
    leases:              ['leases', 'lease_risk_dashboard', 'companies'],
    buildings:           ['buildings', 'leases', 'building_distress_exposure'],
    distress:            ['distress_events', 'leases', 'lease_risk_dashboard', 'building_distress_exposure'],
    corporate_expansion: ['demand_signals', 'companies', 'leases'],
    financial:           ['leases', 'buildings', 'distress_events', 'demand_signals'],
    knowledge_graph:     ['knowledge_graph_edges', 'companies', 'buildings'],
  };

  // ── Dynamic dataset registry ──────────────────────────────────────────────
  // Populated at runtime from the `datasets` Supabase table
  let _dynamicDatasets = {};

  /**
   * Register a user-imported dataset so the router can include it.
   * @param {string} tableName
   * @param {Array<{name:string, type:string}>} columns
   * @param {string} friendlyName
   */
  function registerDataset(tableName, columns, friendlyName = '') {
    _dynamicDatasets[tableName] = {
      description: `User-imported dataset: ${friendlyName || tableName}`,
      columns: columns.map(c => ({ name: c.name, type: c.type, notes: 'imported column' })),
    };
  }

  /**
   * Build the minimal schema context string for a given intent.
   * @param {string} intent
   * @returns {string} Schema context to inject into LLM prompt
   */
  function buildSchemaContext(intent) {
    const tableNames = INTENT_TABLE_MAP[intent] || INTENT_TABLE_MAP['leases'];
    let context = '';

    for (const tableName of tableNames) {
      const def = FULL_SCHEMA[tableName] || _dynamicDatasets[tableName];
      if (!def) continue;
      context += `\nTable: ${tableName}\n`;
      context += `  Description: ${def.description}\n`;
      context += `  Columns:\n`;
      for (const col of def.columns) {
        context += `    - ${col.name} (${col.type}): ${col.notes}\n`;
      }
    }

    // Also include any user datasets that might be relevant
    for (const [tbl, def] of Object.entries(_dynamicDatasets)) {
      if (!tableNames.includes(tbl)) {
        context += `\nUser dataset: ${tbl}\n  Description: ${def.description}\n  Columns:\n`;
        for (const col of def.columns) {
          context += `    - ${col.name} (${col.type})\n`;
        }
      }
    }

    return context || 'No schema available for this intent.';
  }

  /**
   * Get the list of table names for an intent.
   * @param {string} intent
   * @returns {string[]}
   */
  function getTablesForIntent(intent) {
    return INTENT_TABLE_MAP[intent] || [];
  }

  /**
   * Get all registered table names (core + dynamic).
   * @returns {string[]}
   */
  function getAllTableNames() {
    return [...Object.keys(FULL_SCHEMA), ...Object.keys(_dynamicDatasets)];
  }

  /**
   * Load dynamic datasets from Supabase `datasets` table.
   * Call this once on app startup.
   * @param {Object} supabase - initialized Supabase JS client
   */
  async function loadDynamicDatasets(supabase) {
    try {
      const { data, error } = await supabase
        .from('datasets')
        .select('table_name, dataset_name, columns');
      if (error) throw error;
      for (const row of (data || [])) {
        if (row.table_name && row.columns) {
          registerDataset(row.table_name, row.columns, row.dataset_name);
        }
      }
      console.log(`[SchemaRouter] Loaded ${(data || []).length} dynamic datasets`);
    } catch (err) {
      console.warn('[SchemaRouter] Could not load dynamic datasets:', err.message);
    }
  }

  return {
    buildSchemaContext,
    getTablesForIntent,
    getAllTableNames,
    registerDataset,
    loadDynamicDatasets,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SchemaRouter;
}
