/**
 * intent_classifier.js — NEXUS ASIA CRE Intelligence Platform
 * ============================================================
 * Keyword-based intent classifier for routing user questions
 * to the correct database tables.
 *
 * Returns one of:
 *   leases | buildings | distress | corporate_expansion | financial | knowledge_graph
 *
 * The classifier runs entirely in the browser — no network call needed.
 */

'use strict';

const IntentClassifier = (() => {

  // ── Keyword dictionary ──────────────────────────────────────────────────────
  // Each intent has a list of trigger keywords/phrases.
  // Longer phrases are checked first to avoid false positives.
  const INTENT_RULES = [
    {
      intent: 'knowledge_graph',
      keywords: [
        'linked to', 'connected to', 'related to', 'relationship', 'network',
        'lender', 'financed by', 'owns', 'knowledge graph', 'edges',
        'who finances', 'who owns',
      ],
      weight: 10,
    },
    {
      intent: 'distress',
      keywords: [
        'distress', 'distressed', 'insolvency', 'insolvent', 'nclt', 'ibbi',
        'sarfaesi', 'default', 'defaulted', 'bankrupt', 'bankruptcy',
        'liquidat', 'winding up', 'wound up', 'npa', 'debt restructur',
        'wilful defaulter', 'enforcement notice', 'restructur',
      ],
      weight: 12,
    },
    {
      intent: 'corporate_expansion',
      keywords: [
        'expansion', 'expand', 'expanding', 'fundrais', 'raised funds',
        'series a', 'series b', 'series c', 'hiring', 'headcount',
        'new office', 'opening office', 'relocation', 'relocat',
        'acquisition', 'acquir', 'growing company', 'demand for office',
        'office space need', 'looking for space',
      ],
      weight: 11,
    },
    {
      intent: 'leases',
      keywords: [
        'lease', 'leases', 'expiry', 'expiring', 'tenant', 'tenants',
        'sqft', 'sq ft', 'square feet', 'floor', 'floors', 'notice period',
        'lock-in', 'rent escalation', 'sublease', 'surrender',
      ],
      weight: 9,
    },
    {
      intent: 'buildings',
      keywords: [
        'building', 'buildings', 'tower', 'park', 'campus', 'property',
        'properties', 'office space', 'vacancy', 'occupancy', 'grade a',
        'grade b', 'micro market', 'bkc', 'whitefield', 'cyber city',
        'hitech city', 'developer', 'owner',
      ],
      weight: 8,
    },
    {
      intent: 'financial',
      keywords: [
        'total rent', 'monthly rent', 'revenue', 'average rent', 'sum',
        'total value', 'how much', 'cost', 'crore', 'lakh', 'rupees',
        'financial exposure', 'total exposure', 'aggregate',
      ],
      weight: 7,
    },
  ];

  // ── City detection ──────────────────────────────────────────────────────────
  const INDIA_CITIES = [
    'mumbai', 'delhi', 'bangalore', 'bengaluru', 'hyderabad', 'pune',
    'chennai', 'kolkata', 'ahmedabad', 'noida', 'gurgaon', 'gurugram',
    'navi mumbai', 'thane', 'chandigarh', 'kochi', 'indore',
  ];

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Classify a user question into an intent category.
   * @param {string} question - raw user question
   * @returns {{ intent: string, confidence: number, city: string|null }}
   */
  function classify(question) {
    if (!question || typeof question !== 'string') {
      return { intent: 'leases', confidence: 0.5, city: null };
    }

    const q = question.toLowerCase().trim();
    const scores = {};

    for (const rule of INTENT_RULES) {
      let hits = 0;
      for (const kw of rule.keywords) {
        if (q.includes(kw)) {
          hits += kw.includes(' ') ? 2 : 1; // multi-word phrases score higher
        }
      }
      if (hits > 0) {
        scores[rule.intent] = (scores[rule.intent] || 0) + hits * rule.weight;
      }
    }

    // Find winning intent
    let bestIntent = 'leases';
    let bestScore  = 0;
    let totalScore = 0;

    for (const [intent, score] of Object.entries(scores)) {
      totalScore += score;
      if (score > bestScore) {
        bestScore  = score;
        bestIntent = intent;
      }
    }

    const confidence = totalScore > 0
      ? Math.min(bestScore / totalScore, 0.99)
      : 0.5;

    // Detect city
    const city = detectCity(q);

    return { intent: bestIntent, confidence: Math.round(confidence * 100) / 100, city };
  }

  /**
   * Detect the first Indian city mentioned in text.
   * @param {string} text
   * @returns {string|null}
   */
  function detectCity(text) {
    const lower = text.toLowerCase();
    for (const city of INDIA_CITIES) {
      if (lower.includes(city)) {
        return city.charAt(0).toUpperCase() + city.slice(1);
      }
    }
    return null;
  }

  /**
   * Return all valid intent categories.
   * @returns {string[]}
   */
  function getIntents() {
    return INTENT_RULES.map(r => r.intent);
  }

  return { classify, detectCity, getIntents };
})();

// CommonJS / ES Module export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = IntentClassifier;
}
