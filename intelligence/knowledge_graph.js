/**
 * knowledge_graph.js — NEXUS ASIA CRE Intelligence Platform
 * ============================================================
 * Manages the knowledge graph stored in `knowledge_graph_edges`.
 * Handles:
 *   - Querying edges by entity
 *   - Inserting new edges
 *   - Building D3.js-compatible node/link data for visualization
 *   - Auto-linking companies to buildings when leases are imported
 */

'use strict';

const KnowledgeGraph = (() => {

  let _supabase = null;

  /** Initialize with a Supabase JS client instance. */
  function init(supabaseClient) {
    _supabase = supabaseClient;
  }

  // ── Edge relationship types ──────────────────────────────────────────────
  const RELATIONSHIP_TYPES = {
    OCCUPIES:         'occupies',
    OWNS:             'owns',
    FINANCES:         'finances',
    SHOWS_DISTRESS:   'shows_distress',
    SHOWS_EXPANSION:  'shows_expansion',
    LEASES_TO:        'leases_to',
    COMPETES_WITH:    'competes_with',
    ACQUIRED_BY:      'acquired_by',
  };

  const ENTITY_TYPES = {
    COMPANY:  'company',
    BUILDING: 'building',
    LENDER:   'lender',
    SIGNAL:   'signal',
    PERSON:   'person',
  };

  // ── Node colours for D3 visualization ────────────────────────────────────
  const NODE_COLORS = {
    company:  '#00d4ff',
    building: '#f59e0b',
    lender:   '#a78bfa',
    signal:   '#f87171',
    person:   '#34d399',
  };

  // ── Query edges ───────────────────────────────────────────────────────────

  /**
   * Get all edges where entity_a or entity_b matches `entityName`.
   * @param {string} entityName
   * @param {number} [depth=1] - not used yet, reserved for multi-hop
   * @returns {Promise<Array>}
   */
  async function getEdgesForEntity(entityName, depth = 1) {
    if (!_supabase) throw new Error('KnowledgeGraph not initialized');
    const name = entityName.toLowerCase();
    const { data, error } = await _supabase
      .from('knowledge_graph_edges')
      .select('*')
      .or(`entity_a.ilike.%${name}%,entity_b.ilike.%${name}%`)
      .limit(200);
    if (error) throw error;
    return data || [];
  }

  /**
   * Get all edges with a specific relationship type.
   * @param {string} relationship
   * @returns {Promise<Array>}
   */
  async function getEdgesByRelationship(relationship) {
    if (!_supabase) throw new Error('KnowledgeGraph not initialized');
    const { data, error } = await _supabase
      .from('knowledge_graph_edges')
      .select('*')
      .eq('relationship', relationship)
      .order('weight', { ascending: false })
      .limit(500);
    if (error) throw error;
    return data || [];
  }

  /**
   * Get all distressed companies with their connected buildings.
   * @returns {Promise<{ company: string, building: string, area?: number }[]>}
   */
  async function getDistressedBuildingExposure() {
    if (!_supabase) throw new Error('KnowledgeGraph not initialized');
    const { data, error } = await _supabase
      .from('knowledge_graph_edges')
      .select('entity_a, entity_b, metadata')
      .eq('relationship', 'shows_distress')
      .limit(500);
    if (error) throw error;

    const distressedCompanies = (data || []).map(e => e.entity_a.toLowerCase());
    if (!distressedCompanies.length) return [];

    const { data: leaseEdges } = await _supabase
      .from('knowledge_graph_edges')
      .select('entity_a, entity_b, metadata')
      .eq('relationship', 'occupies')
      .in('entity_a', distressedCompanies.map(c => c));

    return (leaseEdges || []).map(e => ({
      company:  e.entity_a,
      building: e.entity_b,
      area:     e.metadata?.area,
      expiry:   e.metadata?.expiry,
    }));
  }

  // ── Insert edges ──────────────────────────────────────────────────────────

  /**
   * Insert a single edge (deduplication handled by Supabase ON CONFLICT).
   * @param {Object} edge
   */
  async function addEdge({ entityA, entityAType, entityB, entityBType, relationship, source = '', weight = 1, metadata = {} }) {
    if (!_supabase) throw new Error('KnowledgeGraph not initialized');
    const { error } = await _supabase
      .from('knowledge_graph_edges')
      .insert({
        entity_a:      entityA,
        entity_a_type: entityAType,
        entity_b:      entityB,
        entity_b_type: entityBType,
        relationship,
        source,
        weight,
        metadata,
      });
    if (error) console.warn('[KG] Insert edge failed:', error.message);
  }

  /**
   * Batch insert edges.
   * @param {Array<Object>} edges
   */
  async function addEdges(edges) {
    if (!_supabase || !edges.length) return;
    const rows = edges.map(e => ({
      entity_a:      e.entityA,
      entity_a_type: e.entityAType,
      entity_b:      e.entityB,
      entity_b_type: e.entityBType,
      relationship:  e.relationship,
      source:        e.source || '',
      weight:        e.weight || 1,
      metadata:      e.metadata || {},
    }));
    const { error } = await _supabase
      .from('knowledge_graph_edges')
      .insert(rows);
    if (error) console.warn('[KG] Batch insert failed:', error.message);
  }

  // ── D3 visualization data ─────────────────────────────────────────────────

  /**
   * Convert edges to D3 nodes + links.
   * @param {Array} edges - raw edge rows from Supabase
   * @returns {{ nodes: Array, links: Array }}
   */
  function toD3Data(edges) {
    const nodeMap = new Map();
    const links = [];

    for (const edge of edges) {
      // Add entity_a node
      if (!nodeMap.has(edge.entity_a)) {
        nodeMap.set(edge.entity_a, {
          id:    edge.entity_a,
          type:  edge.entity_a_type,
          color: NODE_COLORS[edge.entity_a_type] || '#94a3b8',
          size:  10,
        });
      } else {
        // Increase node size with each connection (centrality proxy)
        nodeMap.get(edge.entity_a).size += 2;
      }
      // Add entity_b node
      if (!nodeMap.has(edge.entity_b)) {
        nodeMap.set(edge.entity_b, {
          id:    edge.entity_b,
          type:  edge.entity_b_type,
          color: NODE_COLORS[edge.entity_b_type] || '#94a3b8',
          size:  10,
        });
      } else {
        nodeMap.get(edge.entity_b).size += 2;
      }

      links.push({
        source:       edge.entity_a,
        target:       edge.entity_b,
        relationship: edge.relationship,
        weight:       edge.weight || 1,
        label:        edge.relationship.replace(/_/g, ' '),
      });
    }

    return {
      nodes: Array.from(nodeMap.values()),
      links,
    };
  }

  /**
   * Load and return D3 graph data for a given entity.
   * @param {string} entityName
   * @returns {Promise<{ nodes: Array, links: Array }>}
   */
  async function getGraphForEntity(entityName) {
    const edges = await getEdgesForEntity(entityName);
    return toD3Data(edges);
  }

  /**
   * Load the full graph (limited for display).
   * @param {number} [limit=300]
   * @returns {Promise<{ nodes: Array, links: Array }>}
   */
  async function getFullGraph(limit = 300) {
    if (!_supabase) throw new Error('KnowledgeGraph not initialized');
    const { data, error } = await _supabase
      .from('knowledge_graph_edges')
      .select('*')
      .order('weight', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return toD3Data(data || []);
  }

  return {
    init,
    RELATIONSHIP_TYPES,
    ENTITY_TYPES,
    NODE_COLORS,
    getEdgesForEntity,
    getEdgesByRelationship,
    getDistressedBuildingExposure,
    addEdge,
    addEdges,
    toD3Data,
    getGraphForEntity,
    getFullGraph,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = KnowledgeGraph;
}
