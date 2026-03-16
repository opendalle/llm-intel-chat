/**
 * parser.js — NEXUS ASIA CRE Intelligence Platform
 * ============================================================
 * Converts raw Supabase JSON rows into rendered HTML:
 *   - Sortable, formatted data tables
 *   - Numeric totals row
 *   - Risk flag highlighting
 *   - CSV export
 */

'use strict';

const Parser = (() => {

  // Columns that should render as currency (INR)
  const CURRENCY_COLS = ['rent', 'total_monthly', 'exposed_monthly_rent', 'revenue_cr'];
  // Columns that should render as sq ft numbers
  const SQFT_COLS = ['area', 'total_area', 'exposed_sqft', 'sqft_needed'];
  // Columns that are dates
  const DATE_COLS = ['lease_start', 'lease_expiry', 'detected_at', 'created_at'];
  // Columns that show percentage
  const PCT_COLS = ['occupancy_pct', 'confidence'];

  let _sortCol   = null;
  let _sortAsc   = true;
  let _lastRows  = [];

  // ── Formatters ────────────────────────────────────────────────────────────

  function formatValue(key, value) {
    if (value === null || value === undefined) return '<span class="null-val">—</span>';

    if (CURRENCY_COLS.includes(key)) {
      const n = parseFloat(value);
      if (isNaN(n)) return value;
      return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    }
    if (SQFT_COLS.includes(key)) {
      const n = parseFloat(value);
      if (isNaN(n)) return value;
      return `${n.toLocaleString('en-IN')} sqft`;
    }
    if (PCT_COLS.includes(key)) {
      const n = parseFloat(value);
      if (isNaN(n)) return value;
      return `${(n * (n <= 1 ? 100 : 1)).toFixed(1)}%`;
    }
    if (DATE_COLS.includes(key) && value) {
      try {
        const d = new Date(value);
        return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: '2-digit' });
      } catch { return value; }
    }
    if (typeof value === 'boolean') {
      return value
        ? '<span class="badge badge-green">Yes</span>'
        : '<span class="badge badge-red">No</span>';
    }
    if (typeof value === 'string' && value.startsWith('http')) {
      return `<a href="${value}" target="_blank" rel="noopener" class="table-link">↗ Source</a>`;
    }
    return String(value);
  }

  function getSeverityClass(key, value) {
    if (key === 'severity' || key === 'distress_severity') {
      const map = { critical: 'sev-critical', high: 'sev-high', medium: 'sev-medium', low: 'sev-low' };
      return map[String(value).toLowerCase()] || '';
    }
    if (key === 'expiry_risk') {
      const map = { CRITICAL: 'sev-critical', HIGH: 'sev-high', MEDIUM: 'sev-medium', LOW: 'sev-low' };
      return map[String(value)] || '';
    }
    if (key === 'signal') {
      const distress = ['insolvency', 'liquidation', 'sarfaesi', 'default', 'bankruptcy', 'debt_restructuring'];
      return distress.includes(String(value)) ? 'sev-high' : 'badge-expansion';
    }
    return '';
  }

  // ── Column header formatting ───────────────────────────────────────────────

  function formatHeader(key) {
    if (key === '_risk_flag') return 'Risk Alert';
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  // ── Main render function ──────────────────────────────────────────────────

  /**
   * Render rows as an HTML table string.
   * @param {Array<Object>} rows - data rows from Supabase
   * @param {Object} options
   * @returns {string} HTML string
   */
  function renderTable(rows, options = {}) {
    if (!rows || rows.length === 0) {
      return '<div class="empty-state"><span class="empty-icon">🔍</span><p>No records found matching your query.</p></div>';
    }

    _lastRows = rows;

    // Determine columns (exclude internal fields except _risk_flag)
    const allKeys = [...new Set(rows.flatMap(r => Object.keys(r)))];
    const displayKeys = allKeys.filter(k => !k.startsWith('_') || k === '_risk_flag');

    // Sort rows
    let sortedRows = [...rows];
    if (_sortCol && displayKeys.includes(_sortCol)) {
      sortedRows.sort((a, b) => {
        const va = a[_sortCol], vb = b[_sortCol];
        if (va === null) return 1;
        if (vb === null) return -1;
        if (!isNaN(parseFloat(va)) && !isNaN(parseFloat(vb))) {
          return _sortAsc ? parseFloat(va) - parseFloat(vb) : parseFloat(vb) - parseFloat(va);
        }
        return _sortAsc
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va));
      });
    }

    // Build header
    let html = `
    <div class="table-wrapper">
      <div class="table-meta">
        <span class="row-count">${rows.length} records</span>
        <button class="btn-export" onclick="Parser.exportCSV()">⬇ Export CSV</button>
      </div>
      <table class="data-table" id="result-table">
        <thead>
          <tr>
            ${displayKeys.map(k => `
              <th data-col="${k}" onclick="Parser.sortBy('${k}')" class="sortable ${_sortCol === k ? (_sortAsc ? 'sort-asc' : 'sort-desc') : ''}">
                ${formatHeader(k)}
                ${_sortCol === k ? (_sortAsc ? ' ▲' : ' ▼') : ' ⇅'}
              </th>`).join('')}
          </tr>
        </thead>
        <tbody>`;

    // Build rows
    for (const row of sortedRows) {
      const hasRisk = row._risk_flag;
      html += `<tr class="${hasRisk ? 'risk-row' : ''}">`;
      for (const key of displayKeys) {
        if (key === '_risk_flag') {
          html += `<td>${row._risk_flag ? `<span class="risk-badge">${row._risk_flag}</span>` : '—'}</td>`;
        } else {
          const cellClass = getSeverityClass(key, row[key]);
          html += `<td class="${cellClass}">${formatValue(key, row[key])}</td>`;
        }
      }
      html += '</tr>';
    }

    // Numeric totals row
    const numericCols = displayKeys.filter(k => {
      return rows.some(r => r[k] !== null && !isNaN(parseFloat(r[k])));
    });

    if (numericCols.length > 0) {
      html += `<tr class="totals-row"><td colspan="${displayKeys.indexOf(numericCols[0])}"><strong>TOTAL</strong></td>`;
      let firstNum = true;
      for (const key of displayKeys) {
        if (!numericCols.includes(key) && firstNum) continue;
        if (numericCols.includes(key)) {
          const total = rows.reduce((sum, r) => sum + (parseFloat(r[key]) || 0), 0);
          html += `<td><strong>${formatValue(key, total)}</strong></td>`;
          firstNum = false;
        } else if (!firstNum) {
          html += `<td></td>`;
        }
      }
      html += '</tr>';
    }

    html += `</tbody></table></div>`;
    return html;
  }

  // ── Sorting (called from table header clicks) ─────────────────────────────

  function sortBy(col) {
    if (_sortCol === col) {
      _sortAsc = !_sortAsc;
    } else {
      _sortCol = col;
      _sortAsc = true;
    }
    // Re-render
    const container = document.getElementById('table-container');
    if (container && _lastRows.length) {
      container.innerHTML = renderTable(_lastRows);
    }
  }

  // ── CSV export ────────────────────────────────────────────────────────────

  function exportCSV() {
    if (!_lastRows.length) return;
    const keys = Object.keys(_lastRows[0]).filter(k => !k.startsWith('_') || k === '_risk_flag');
    const header = keys.join(',');
    const csvRows = _lastRows.map(row =>
      keys.map(k => {
        const v = row[k];
        if (v === null || v === undefined) return '';
        const str = String(v).replace(/"/g, '""');
        return str.includes(',') || str.includes('"') ? `"${str}"` : str;
      }).join(',')
    );
    const csv = [header, ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `nexus_export_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Summary card renderer ─────────────────────────────────────────────────

  /**
   * Render a quick summary card from result rows.
   * @param {Array} rows
   * @param {string} intent
   * @returns {string} HTML
   */
  function renderSummaryCard(rows, intent) {
    if (!rows.length) return '';
    const riskRows = rows.filter(r => r._risk_flag);
    return `
      <div class="summary-card">
        <div class="summary-stat"><span>${rows.length}</span><label>Records</label></div>
        ${riskRows.length ? `<div class="summary-stat risk"><span>${riskRows.length}</span><label>Risk Alerts</label></div>` : ''}
        ${intent === 'leases' ? `<div class="summary-stat"><span>₹${rows.reduce((s, r) => s + (parseFloat(r.total_monthly) || 0), 0).toLocaleString('en-IN', {maximumFractionDigits: 0})}</span><label>Total Monthly Rent</label></div>` : ''}
        ${intent === 'distress' ? `<div class="summary-stat risk"><span>${new Set(rows.map(r => r.company)).size}</span><label>Distressed Companies</label></div>` : ''}
      </div>`;
  }

  return { renderTable, renderSummaryCard, sortBy, exportCSV };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Parser;
}
