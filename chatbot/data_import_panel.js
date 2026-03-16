/**
 * data_import_panel.js — NEXUS ASIA CRE Intelligence Platform
 * ============================================================
 * Handles the Data Import Panel:
 *   1. User pastes Excel/CSV text
 *   2. Detect headers and infer column types
 *   3. Create Supabase table dynamically via INSERT (using datasets registry)
 *   4. Bulk-insert rows into a new or existing user table
 *   5. Register dataset in `datasets` table
 *   6. Update SchemaRouter with new table definition
 */

'use strict';

const DataImportPanel = (() => {

  let _supabase = null;

  function init(supabaseClient) {
    _supabase = supabaseClient;
    _bindUI();
  }

  // ── CSV / Excel paste parser ──────────────────────────────────────────────

  /**
   * Parse raw pasted text (CSV or TSV) into { headers, rows }.
   * Handles:
   *   - Comma-separated CSV
   *   - Tab-separated (pasted from Excel)
   *   - Quoted fields
   */
  function parseInput(rawText) {
    const lines = rawText.trim().split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('Need at least a header row and one data row.');

    // Detect delimiter: if first line has more tabs than commas, it's TSV
    const firstLine = lines[0];
    const tabCount   = (firstLine.match(/\t/g) || []).length;
    const commaCount = (firstLine.match(/,/g)  || []).length;
    const delimiter  = tabCount >= commaCount ? '\t' : ',';

    function parseLine(line) {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
          else inQuotes = !inQuotes;
        } else if (ch === delimiter && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    }

    const headers = parseLine(lines[0]).map(h => sanitizeColumnName(h));
    const dataRows = lines.slice(1).map(line => {
      const values = parseLine(line);
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = values[i] !== undefined ? values[i] : null;
      });
      return obj;
    }).filter(row => Object.values(row).some(v => v !== null && v !== ''));

    return { headers, dataRows };
  }

  /**
   * Sanitize column names to valid PostgreSQL identifiers.
   */
  function sanitizeColumnName(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^(\d)/, '_$1')
      .replace(/__+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 63) || 'col';
  }

  // ── Type inference ────────────────────────────────────────────────────────

  /**
   * Infer PostgreSQL type from a sample of values.
   * @param {string[]} values
   * @returns {'INTEGER' | 'NUMERIC' | 'DATE' | 'BOOLEAN' | 'TEXT'}
   */
  function inferType(values) {
    const non_empty = values.filter(v => v !== null && v !== '' && v !== undefined);
    if (!non_empty.length) return 'TEXT';

    // Boolean
    const boolVals = new Set(['true', 'false', 'yes', 'no', '1', '0', 'y', 'n']);
    if (non_empty.every(v => boolVals.has(String(v).toLowerCase()))) return 'BOOLEAN';

    // Integer
    if (non_empty.every(v => /^-?\d+$/.test(String(v).trim()))) return 'INTEGER';

    // Numeric (float)
    if (non_empty.every(v => /^-?[\d,]+\.?\d*$/.test(String(v).replace(/,/g, '').trim()))) return 'NUMERIC';

    // Date
    const dateRe = /^\d{4}-\d{2}-\d{2}$|^\d{2}[\/\-]\d{2}[\/\-]\d{2,4}$/;
    if (non_empty.every(v => dateRe.test(String(v).trim()))) return 'DATE';

    return 'TEXT';
  }

  /**
   * Infer column definitions from parsed data.
   * @param {string[]} headers
   * @param {Object[]} dataRows
   * @returns {Array<{ name: string, type: string }>}
   */
  function inferSchema(headers, dataRows) {
    return headers.map(h => {
      const values = dataRows.map(r => r[h]);
      return { name: h, type: inferType(values) };
    });
  }

  // ── Value coercion ────────────────────────────────────────────────────────

  function coerceValue(value, type) {
    if (value === null || value === '' || value === undefined) return null;
    const v = String(value).trim();
    switch (type) {
      case 'INTEGER': return parseInt(v.replace(/,/g, ''), 10) || null;
      case 'NUMERIC': return parseFloat(v.replace(/,/g, '')) || null;
      case 'BOOLEAN': return ['true', 'yes', '1', 'y'].includes(v.toLowerCase());
      case 'DATE':    {
        // Try standard ISO first
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
        // Try dd/mm/yyyy
        const parts = v.split(/[\/\-]/);
        if (parts.length === 3) {
          if (parts[2].length === 4) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
          return `${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
        }
        return null;
      }
      default: return v;
    }
  }

  // ── Table name generator ──────────────────────────────────────────────────

  function generateTableName(datasetName) {
    const base = sanitizeColumnName(datasetName || 'import') || 'import';
    const ts   = Date.now().toString().slice(-6);
    return `ds_${base}_${ts}`.substring(0, 63);
  }

  // ── Supabase import ───────────────────────────────────────────────────────

  /**
   * Main import function: parse → infer → insert → register.
   * @param {string} rawText - pasted CSV/TSV text
   * @param {string} datasetName - user-provided name
   * @param {Function} onProgress - callback(percent, message)
   * @returns {{ success: boolean, rowsInserted: number, tableName: string, schema: Array }}
   */
  async function importData(rawText, datasetName, onProgress = () => {}) {
    if (!_supabase) throw new Error('Supabase client not initialized');

    onProgress(5, 'Parsing data...');
    const { headers, dataRows } = parseInput(rawText);
    if (!headers.length) throw new Error('No columns detected.');
    if (!dataRows.length)  throw new Error('No data rows found.');

    onProgress(15, `Detected ${headers.length} columns, ${dataRows.length} rows. Inferring types...`);
    const schema = inferSchema(headers, dataRows);

    const tableName = generateTableName(datasetName);
    onProgress(25, `Target table: ${tableName}`);

    // Coerce all row values
    const coercedRows = dataRows.map(row => {
      const out = { _imported_at: new Date().toISOString() };
      schema.forEach(col => {
        out[col.name] = coerceValue(row[col.name], col.type);
      });
      return out;
    });

    // Insert in chunks of 100
    const CHUNK = 100;
    let inserted = 0;
    for (let i = 0; i < coercedRows.length; i += CHUNK) {
      const chunk = coercedRows.slice(i, i + CHUNK);
      const { error } = await _supabase.from(tableName).insert(chunk);
      if (error) {
        console.error('[DataImport] Insert error:', error);
        // If table doesn't exist yet, this will fail — need to create it first
        // Supabase does not support CREATE TABLE from the anon client directly.
        // Guide user to create via schema.sql or a Supabase function.
        throw new Error(
          `Insert failed: ${error.message}. ` +
          `Table "${tableName}" may not exist. ` +
          `Please run the CREATE TABLE statement shown below first in your Supabase SQL Editor.`
        );
      }
      inserted += chunk.length;
      const pct = 25 + Math.round((inserted / coercedRows.length) * 65);
      onProgress(pct, `Inserted ${inserted} / ${coercedRows.length} rows...`);
    }

    // Register in datasets table
    onProgress(92, 'Registering dataset...');
    await _supabase.from('datasets').insert({
      dataset_name: datasetName || tableName,
      table_name:   tableName,
      columns:      schema,
      row_count:    inserted,
      source_file:  'manual_import',
    });

    // Register with SchemaRouter if available
    if (typeof SchemaRouter !== 'undefined') {
      SchemaRouter.registerDataset(tableName, schema, datasetName);
    }

    onProgress(100, `✅ Import complete! ${inserted} rows in ${tableName}`);
    return { success: true, rowsInserted: inserted, tableName, schema };
  }

  // ── Generate CREATE TABLE SQL for manual execution ────────────────────────

  function generateCreateSQL(tableName, schema) {
    const cols = schema.map(c => `  ${c.name} ${c.type}`).join(',\n');
    return `-- Run this in your Supabase SQL Editor:\nCREATE TABLE IF NOT EXISTS ${tableName} (\n  id BIGSERIAL PRIMARY KEY,\n${cols},\n  _imported_at TIMESTAMPTZ DEFAULT NOW()\n);`;
  }

  // ── UI Bindings ───────────────────────────────────────────────────────────

  function _bindUI() {
    const importBtn     = document.getElementById('import-btn');
    const previewBtn    = document.getElementById('preview-btn');
    const pasteArea     = document.getElementById('paste-area');
    const datasetNameEl = document.getElementById('dataset-name');
    const progressEl    = document.getElementById('import-progress');
    const previewEl     = document.getElementById('import-preview');
    const sqlPreviewEl  = document.getElementById('sql-preview');

    if (previewBtn) {
      previewBtn.addEventListener('click', () => {
        try {
          const raw = pasteArea?.value || '';
          if (!raw.trim()) { showError('Paste your CSV/Excel data first.'); return; }
          const { headers, dataRows } = parseInput(raw);
          const schema = inferSchema(headers, dataRows);
          const tableName = generateTableName(datasetNameEl?.value || 'preview');

          // Preview table
          if (previewEl) {
            let html = '<table class="preview-table"><thead><tr>';
            headers.forEach(h => { html += `<th>${h}<br><small>${schema.find(s=>s.name===h)?.type || 'TEXT'}</small></th>`; });
            html += '</tr></thead><tbody>';
            dataRows.slice(0, 5).forEach(row => {
              html += '<tr>';
              headers.forEach(h => { html += `<td>${row[h] !== null ? row[h] : '—'}</td>`; });
              html += '</tr>';
            });
            if (dataRows.length > 5) html += `<tr><td colspan="${headers.length}" class="see-more">... and ${dataRows.length - 5} more rows</td></tr>`;
            html += '</tbody></table>';
            html += `<p class="preview-meta">${headers.length} columns | ${dataRows.length} rows detected</p>`;
            previewEl.innerHTML = html;
            previewEl.style.display = 'block';
          }

          // SQL preview
          if (sqlPreviewEl) {
            sqlPreviewEl.textContent = generateCreateSQL(tableName, schema);
            sqlPreviewEl.style.display = 'block';
          }
        } catch (err) {
          showError(err.message);
        }
      });
    }

    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        try {
          const raw         = pasteArea?.value || '';
          const datasetName = datasetNameEl?.value?.trim() || 'My Dataset';
          if (!raw.trim()) { showError('Paste your CSV/Excel data first.'); return; }

          importBtn.disabled   = true;
          importBtn.textContent = 'Importing...';

          const result = await importData(raw, datasetName, (pct, msg) => {
            if (progressEl) {
              progressEl.innerHTML = `
                <div class="progress-bar-wrap">
                  <div class="progress-bar-fill" style="width:${pct}%"></div>
                </div>
                <p class="progress-msg">${msg}</p>`;
              progressEl.style.display = 'block';
            }
          });

          showSuccess(`✅ Imported ${result.rowsInserted} rows to <code>${result.tableName}</code>. The chatbot can now query this dataset.`);
          // Refresh dataset list
          if (typeof loadDatasetList === 'function') loadDatasetList();
        } catch (err) {
          showError(`Import failed: ${err.message}`);
        } finally {
          importBtn.disabled    = false;
          importBtn.textContent = '⬆ Import Data';
        }
      });
    }
  }

  function showError(msg) {
    const el = document.getElementById('import-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
    else console.error('[DataImport]', msg);
  }

  function showSuccess(msg) {
    const el = document.getElementById('import-success');
    if (el) { el.innerHTML = msg; el.style.display = 'block'; }
  }

  return { init, parseInput, inferSchema, inferType, importData, generateCreateSQL };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DataImportPanel;
}
