// Shared SQL scratch-editor tab used by <table-details> and <db-details> so the
// SQL tab is identical everywhere: an editable CodeMirror editor with syntax
// highlighting, schema-aware autocompletion (IntelliSense) and live red-squiggly
// syntax linting, plus a Run button (Ctrl/Cmd+Enter) that executes the query
// against the active connection string + database and shows the results.
window.SqlScratchTab = {
  async mount(host, opts) {
    host.innerHTML = '';

    const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

    // Lay everything out inside an inner container so we don't touch the host's
    // own classes (the host is a daisyUI `.tab-content` panel whose class
    // controls tab show/hide — overwriting it would break the other tabs).
    const root = document.createElement('div');
    root.className = 'flex flex-col gap-2';
    host.appendChild(root);

    // Make the tab fill the available viewport height so the editor/results
    // split can use it. Recomputed on resize.
    const sizeHost = () => {
      const top = root.getBoundingClientRect().top;
      root.style.height = Math.max(320, window.innerHeight - top - 16) + 'px';
    };
    sizeHost();
    window.addEventListener('resize', sizeHost);

    // Toolbar: Run buttons + hint.
    const bar = document.createElement('div');
    bar.className = 'relative flex flex-wrap items-center gap-3 shrink-0';
    const runAll = document.createElement('button');
    runAll.type = 'button';
    runAll.className = 'btn btn-sm btn-square btn-primary';
    runAll.title = 'Run all (Ctrl+Shift+Enter)';
    runAll.innerHTML = '<i data-lucide="play" class="size-4"></i>';
    const runCurrent = document.createElement('button');
    runCurrent.type = 'button';
    runCurrent.className = 'btn btn-sm btn-square btn-outline btn-primary';
    runCurrent.title = 'Run current or selected statement (Ctrl+Enter)';
    runCurrent.innerHTML = '<i data-lucide="step-forward" class="size-4"></i>';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn btn-sm btn-square btn-success';
    refreshBtn.innerHTML = '<i data-lucide="refresh-cw" class="size-4"></i>';
    refreshBtn.disabled = true;
    const trashBtn = document.createElement('button');
    trashBtn.type = 'button';
    trashBtn.className = 'btn btn-sm btn-square btn-error';
    trashBtn.innerHTML = '<i data-lucide="trash" class="size-4"></i>';
    trashBtn.disabled = true;
    // Centered group: decrease / increase the editor font size.
    const fontGroup = document.createElement('div');
    fontGroup.className = 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-1';
    const decFont = document.createElement('button');
    decFont.type = 'button';
    decFont.className = 'btn btn-sm btn-square btn-ghost';
    decFont.title = 'Decrease font size';
    decFont.innerHTML = '<i data-lucide="zoom-out" class="size-4"></i>';
    const incFont = document.createElement('button');
    incFont.type = 'button';
    incFont.className = 'btn btn-sm btn-square btn-ghost';
    incFont.title = 'Increase font size';
    incFont.innerHTML = '<i data-lucide="zoom-in" class="size-4"></i>';
    fontGroup.append(decFont, incFont);
    // Right-aligned group: copy / export / load the editor contents.
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-sm btn-square btn-ghost ml-auto';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = '<i data-lucide="clipboard" class="size-4"></i>';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn btn-sm btn-square btn-ghost';
    exportBtn.title = 'Export';
    exportBtn.innerHTML = '<i data-lucide="download" class="size-4"></i>';
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'btn btn-sm btn-square btn-ghost';
    loadBtn.title = 'Load SQL file';
    loadBtn.innerHTML = '<i data-lucide="upload" class="size-4"></i>';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.sql,text/plain';
    fileInput.className = 'hidden';
    bar.append(runAll, runCurrent, refreshBtn, trashBtn, fontGroup, copyBtn, exportBtn, loadBtn, fileInput);
    if (window.lucide) window.lucide.createIcons({ root: bar });

    // Editor — starts at 40% of the remaining height; user-resizable via the
    // splitter below. `relative` so the results-navigation overlay can anchor
    // to its bottom-right corner (and follow it while resizing).
    const wrap = document.createElement('div');
    wrap.className = 'relative overflow-hidden rounded-lg border border-base-300 bg-base-200 min-h-0';
    wrap.style.flex = '0 0 40%';

    // Draggable splitter to adjust the editor/results heights.
    const splitter = document.createElement('div');
    splitter.className = 'dashed-sep-h shrink-0 h-1.5 cursor-row-resize transition-colors';
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'horizontal');

    // Results — fills the remaining space and scrolls internally.
    const results = document.createElement('div');
    results.className = 'overflow-auto min-h-0';
    results.style.flex = '1 1 0';

    root.append(bar, wrap, splitter, results);

    // Splitter drag: resize the editor pane between 15% and 85% of the area
    // available below the toolbar.
    let dragging = false;
    const onDown = (e) => {
      dragging = true;
      splitter.classList.add('dashed-sep-active');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const area = root.getBoundingClientRect();
      const top = wrap.getBoundingClientRect().top;
      const avail = area.bottom - top;
      let h = e.clientY - top;
      h = Math.max(avail * 0.15, Math.min(avail * 0.85, h));
      wrap.style.flex = '0 0 ' + h + 'px';
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('dashed-sep-active');
      document.body.style.userSelect = '';
    };
    splitter.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    if (!window.SqlEditor || !window.SqlEditor.createEditable) {
      // Fallback: a plain textarea if the editor bundle failed to load.
      const ta = document.createElement('textarea');
      ta.className = 'textarea textarea-bordered h-full w-full font-mono';
      ta.placeholder = '-- Write SQL here';
      wrap.appendChild(ta);
      runAll.disabled = true;
      runCurrent.disabled = true;
      return {
        destroy() {
          window.removeEventListener('resize', sizeHost);
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        },
      };
    }

    const runAllQuery = () => this._execute(window.SqlEditor.getValue(view), opts, ctx, bar);
    const runCurrentQuery = () => this._execute(window.SqlEditor.getStatementAtCursor(view), opts, ctx, bar);
    // Remember the editor contents per context (database, and each table).
    const storageKey = this._storageKey(opts);
    const saveId = opts && opts.table ? 'tableSql' : 'dbSql';
    let initialDoc = '';
    try { initialDoc = localStorage.getItem(storageKey) || ''; } catch (e) { /* ignore */ }
    // Persist edits (debounced) so the content survives refreshes and remounts.
    let saveTimer = null;
    const persistDoc = (text) => {
      updateEmptyState(text);
      if (window.saveEnabled && !window.saveEnabled(saveId)) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try { localStorage.setItem(storageKey, text); } catch (e) { /* ignore */ }
      }, 250);
    };
    // Disable run/export actions while the editor is empty (nothing to run or save).
    const updateEmptyState = (text) => {
      const empty = !String(text == null ? '' : text).trim();
      runAll.disabled = empty;
      runCurrent.disabled = empty;
      exportBtn.disabled = empty;
    };
    const view = window.SqlEditor.createEditable(wrap, initialDoc, isDark(), {}, {
      onRunAll: runAllQuery,
      onRunCurrent: runCurrentQuery,
      onChange: persistDoc,
    });
    updateEmptyState(initialDoc);
    // Let the editor fill its 40% pane and scroll internally.
    view.dom.style.height = '100%';
    view.dom.style.maxHeight = 'none';
    // Editor font size (persisted, shared across tabs) with +/- controls.
    let fontSize = parseInt(localStorage.getItem('sql-editor-font') || '', 10);
    if (!(fontSize >= 8 && fontSize <= 40)) fontSize = 14;
    const applyFont = () => {
      view.dom.style.fontSize = fontSize + 'px';
      if (view.requestMeasure) view.requestMeasure();
      try { localStorage.setItem('sql-editor-font', String(fontSize)); } catch (e) { /* ignore */ }
    };
    applyFont();
    decFont.addEventListener('click', () => { fontSize = Math.max(8, fontSize - 1); applyFont(); });
    incFont.addEventListener('click', () => { fontSize = Math.min(40, fontSize + 1); applyFont(); });
    runAll.addEventListener('click', runAllQuery);
    runCurrent.addEventListener('click', runCurrentQuery);

    // Update: open an edit modal for the selected row. The table comes from the
    // tab (table-details) or is inferred from the row's originating SQL.
    refreshBtn.addEventListener('click', () => {
      const tr = ctx.selectedRow;
      if (!tr || !tr._row) return;
      const ref = opts.table ? { schema: opts.schema || 'dbo', table: opts.table } : tr._table;
      if (!ref || !ref.table) return;
      this._openEditModal(ctx, tr._row, ref);
    });

    // Delete: confirm, then append a DELETE statement for the selected row.
    trashBtn.addEventListener('click', () => {
      const tr = ctx.selectedRow;
      if (!tr || !tr._row) return;
      const ref = opts.table ? { schema: opts.schema || 'dbo', table: opts.table } : tr._table;
      if (!ref || !ref.table) return;
      this._openDeleteModal(ctx, tr._row, ref);
    });

    // Briefly swap a toolbar button's icon to a check mark to confirm an action
    // succeeded, then restore its original icon.
    const flashCheck = (btn, icon) => {
      btn.innerHTML = '<i data-lucide="check" class="size-4"></i>';
      if (window.lucide) window.lucide.createIcons({ root: btn });
      setTimeout(() => {
        btn.innerHTML = '<i data-lucide="' + icon + '" class="size-4"></i>';
        if (window.lucide) window.lucide.createIcons({ root: btn });
      }, 1200);
    };

    // Copy the entire editor contents to the clipboard.
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(window.SqlEditor.getValue(view))
        .then(() => flashCheck(copyBtn, 'clipboard'))
        .catch(() => {});
    });

    // Export the editor contents as a .sql file named
    // "<database> - <table>-<mm-dd-hh-mm-ss>.sql".
    exportBtn.addEventListener('click', () => {
      const now = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const stamp = p(now.getMonth() + 1) + '-' + p(now.getDate()) + '-' +
        p(now.getHours()) + '-' + p(now.getMinutes()) + '-' + p(now.getSeconds());
      const parts = [opts.database, opts.table].filter(Boolean).join(' - ');
      const name = (parts ? parts + '-' : '') + stamp + '.sql';
      const blob = new Blob([window.SqlEditor.getValue(view)], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flashCheck(exportBtn, 'download');
    });

    // Load a .sql file's contents into the editor.
    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        window.SqlEditor.setValue(view, String(reader.result || ''));
        ctx.persist();
        fileInput.value = '';
        flashCheck(loadBtn, 'upload');
      };
      reader.readAsText(file);
    });

    // Results-navigation overlay, anchored to the editor's bottom-right corner.
    // Shown only when a run produced multiple result sets; its buttons jump the
    // results scrollbar from one result to the next/previous.
    const overlay = document.createElement('div');
    overlay.className = 'absolute bottom-2 right-2 z-20 hidden items-center gap-1 rounded-lg ' +
      'border border-base-300 bg-base-100/90 p-1 shadow-lg backdrop-blur';
    const navPrev = document.createElement('button');
    navPrev.type = 'button';
    navPrev.className = 'btn btn-xs btn-ghost';
    navPrev.textContent = '‹';
    navPrev.title = 'Previous result';
    const navLabel = document.createElement('span');
    navLabel.className = 'px-1 text-xs tabular-nums text-base-content/70';
    navLabel.textContent = '1 / 1';
    const navNext = document.createElement('button');
    navNext.type = 'button';
    navNext.className = 'btn btn-xs btn-ghost';
    navNext.textContent = '›';
    navNext.title = 'Next result';
    overlay.append(navPrev, navLabel, navNext);
    wrap.appendChild(overlay);

    const ctx = { results, sections: [], current: 0, refreshBtn, trashBtn, selectedRow: null, opts, view, editMeta: null };
    // Persists the editor contents for this context's storage key.
    ctx.persist = () => {
      if (window.saveEnabled && !window.saveEnabled(saveId)) return;
      try { localStorage.setItem(storageKey, window.SqlEditor.getValue(view)); } catch (e) { /* ignore */ }
    };
    // Selects a single result row (clearing any previous selection) and enables
    // the update/delete buttons. Passing null clears the selection.
    ctx.selectRow = (tr) => {
      if (ctx.selectedRow) ctx.selectedRow.classList.remove('!bg-primary', '!text-primary-content');
      ctx.selectedRow = tr;
      if (tr) tr.classList.add('!bg-primary', '!text-primary-content');
      const canEdit = !!(tr && (opts.table || (tr._table && tr._table.table)));
      refreshBtn.disabled = !canEdit;
      trashBtn.disabled = !tr;
    };
    const goTo = (idx) => {
      const secs = ctx.sections;
      if (!secs.length) return;
      ctx.current = Math.max(0, Math.min(secs.length - 1, idx));
      const sec = secs[ctx.current];
      const top = sec.getBoundingClientRect().top - results.getBoundingClientRect().top + results.scrollTop;
      results.scrollTo({ top, behavior: 'auto' });
      navLabel.textContent = (ctx.current + 1) + ' / ' + secs.length;
    };
    navPrev.addEventListener('click', () => goTo(ctx.current - 1));
    navNext.addEventListener('click', () => goTo(ctx.current + 1));
    // Keep the counter in sync as the user scrolls the results manually.
    results.addEventListener('scroll', () => {
      const secs = ctx.sections;
      if (secs.length < 2) return;
      const rTop = results.getBoundingClientRect().top;
      let idx = 0;
      secs.forEach((s, i) => { if (s.getBoundingClientRect().top - rTop <= 8) idx = i; });
      ctx.current = idx;
      navLabel.textContent = (idx + 1) + ' / ' + secs.length;
    });
    // Called by _showResults to reflect the latest run.
    ctx.updateOverlay = () => {
      const n = ctx.sections.length;
      ctx.current = 0;
      if (n > 1) {
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
        navLabel.textContent = '1 / ' + n;
      } else {
        overlay.classList.add('hidden');
        overlay.classList.remove('flex');
      }
    };

    // Keep the editor theme in sync with the app's light/dark theme.
    const observer = new MutationObserver(() => window.SqlEditor.setDark(view, isDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Load the completion schema (tables/columns) for the active database.
    try {
      const res = await fetch('/api/schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionString: opts.cs, database: opts.database }),
      });
      const d = await res.json();
      if (d && d.ok && d.schema) window.SqlEditor.setSchema(view, d.schema);
    } catch { /* completions are best-effort */ }

    return {
      destroy() {
        window.removeEventListener('resize', sizeHost);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        observer.disconnect();
        view.destroy();
      },
    };
  },

  async _execute(sql, opts, ctx, bar) {
    sql = (sql || '').trim();
    if (!sql) return;
    const results = ctx.results;
    // The update/delete buttons are driven by row selection, not the run cycle.
    const buttons = Array.from(bar.querySelectorAll('button'))
      .filter(b => b !== ctx.refreshBtn && b !== ctx.trashBtn);
    buttons.forEach(b => (b.disabled = true));
    ctx.sections = [];
    if (ctx.updateOverlay) ctx.updateOverlay();
    results.innerHTML = '<p class="text-base-content/60">Running…</p>';
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionString: opts.cs, database: opts.database, sql }),
      });
      const d = await res.json();
      if (!d.ok) { this._showError(results, d.error); return; }
      this._showResults(ctx, d, sql);
    } catch (e) {
      this._showError(results, (e && e.message) || 'Request failed');
    } finally {
      buttons.forEach(b => (b.disabled = false));
    }
  },

  _showError(results, message) {
    results.innerHTML = '';
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.className = 'alert alert-error alert-soft';
    alert.textContent = message || 'Query failed.';
    results.appendChild(alert);
  },

  // Splits a SQL batch into individual statements on top-level semicolons,
  // ignoring semicolons inside quotes, [bracketed] identifiers and comments.
  _splitStatements(sql) {
    const doc = sql || '';
    const parts = [];
    let start = 0;
    let inSingle = false, inDouble = false, inBracket = false, inLine = false, inBlock = false;
    for (let i = 0; i < doc.length; i++) {
      const c = doc[i];
      const n = doc[i + 1];
      if (inLine) { if (c === '\n') inLine = false; continue; }
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
      if (inSingle) { if (c === "'") inSingle = false; continue; }
      if (inDouble) { if (c === '"') inDouble = false; continue; }
      if (inBracket) { if (c === ']') inBracket = false; continue; }
      if (c === '-' && n === '-') { inLine = true; i++; continue; }
      if (c === '/' && n === '*') { inBlock = true; i++; continue; }
      if (c === "'") { inSingle = true; continue; }
      if (c === '"') { inDouble = true; continue; }
      if (c === '[') { inBracket = true; continue; }
      if (c === ';') {
        const s = doc.slice(start, i).trim();
        if (s) parts.push(s);
        start = i + 1;
      }
    }
    const tail = doc.slice(start).trim();
    if (tail) parts.push(tail);
    return parts;
  },

  // A highlighted (yellow) header showing the SQL that produced the result,
  // with a copy button. Doubles as a visual separator between result tables.
  // When a result `set` is given, also offers a "Copy results" (Excel/Teams) button.
  _queryHeader(sqlText, set) {
    const wrap = document.createElement('div');
    wrap.className = 'mb-2 flex items-start gap-2 rounded-lg bg-warning text-warning-content shadow-md p-2';
    const pre = document.createElement('pre');
    pre.className = 'flex-1 overflow-auto text-sm font-bold whitespace-pre-wrap font-mono m-0';
    const code = document.createElement('code');
    code.textContent = sqlText;
    pre.appendChild(code);

    const actions = document.createElement('div');
    actions.className = 'flex shrink-0 gap-1';

    const feedback = (btn, label) => {
      const prev = btn.innerHTML;
      btn.innerHTML = '<i data-lucide="check" class="size-4"></i>';
      if (window.lucide) window.lucide.createIcons({ root: btn });
      setTimeout(() => { btn.innerHTML = prev; }, 1200);
    };

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-xs btn-square';
    copyBtn.innerHTML = '<i data-lucide="code" class="size-4"></i>';
    copyBtn.title = 'Copy the SQL';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(sqlText)
        .then(() => feedback(copyBtn, 'Copied'))
        .catch(() => { /* clipboard may be unavailable */ });
    });
    actions.appendChild(copyBtn);

    if (set && set.columns && set.columns.length) {
      const copyRes = document.createElement('button');
      copyRes.type = 'button';
      copyRes.className = 'btn btn-xs btn-square';
      copyRes.innerHTML = '<i data-lucide="table" class="size-4"></i>';
      copyRes.title = 'Copy results (paste into Excel or Teams)';
      copyRes.addEventListener('click', () => {
        this._copyResults(set).then(() => feedback(copyRes, 'Copied')).catch(() => {});
      });
      actions.appendChild(copyRes);
    }

    wrap.append(pre, actions);
    if (window.lucide) window.lucide.createIcons({ root: wrap });
    return wrap;
  },

  // Copies a result set to the clipboard as both an HTML table (so Excel and
  // Teams render proper cells) and tab-separated text (Excel fallback).
  async _copyResults(set) {
    const html = this._toHtml(set);
    const tsv = this._toTsv(set);
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([tsv], { type: 'text/plain' }),
        })]);
        return;
      }
    } catch { /* fall through to plain-text copy */ }
    await navigator.clipboard.writeText(tsv);
  },

  // Tab-separated values — pastes into Excel as separate cells.
  _toTsv(set) {
    const esc = (v) => (v === null || v === undefined ? '' : String(v))
      .replace(/\r?\n/g, ' ')
      .replace(/\t/g, ' ');
    const header = set.columns.map(esc).join('\t');
    const body = set.rows.map(row => set.columns.map(c => esc(row[c])).join('\t'));
    return [header, ...body].join('\n');
  },

  // HTML table — pastes into Excel/Teams as a formatted table.
  _toHtml(set) {
    const esc = (v) => (v === null || v === undefined ? '' : String(v))
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const head = '<tr>' + set.columns.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr>';
    const body = set.rows.map(row =>
      '<tr>' + set.columns.map(c => '<td>' + esc(row[c]) + '</td>').join('') + '</tr>'
    ).join('');
    return '<table border="1" cellspacing="0" cellpadding="4"><thead>' + head +
      '</thead><tbody>' + body + '</tbody></table>';
  },

  _showResults(ctx, d, sql) {
    const results = ctx.results;
    results.innerHTML = '';
    ctx.sections = [];
    if (ctx.selectRow) ctx.selectRow(null);

    const sets = (d.resultSets || []).filter(s => s.columns && s.columns.length);
    const statements = this._splitStatements(sql);

    if (!sets.length) {
      const affected = (d.rowsAffected || []).reduce((a, b) => a + b, 0);
      if (sql) results.appendChild(this._queryHeader(sql));
      const info = document.createElement('div');
      info.setAttribute('role', 'alert');
      info.className = 'alert alert-success alert-soft';
      info.textContent = 'Query executed. ' + affected + ' row(s) affected.';
      results.appendChild(info);
      if (ctx.updateOverlay) ctx.updateOverlay();
      return;
    }

    sets.forEach((set, i) => {
      // Each result set gets its own section so the navigation overlay can
      // scroll the results pane straight to it.
      const section = document.createElement('div');
      if (i > 0) section.className = 'mt-6';

      // Show the statement that produced this result set (best-effort pairing)
      // as a highlighted separator with a copy button.
      const stmt = statements.length === sets.length
        ? statements[i]
        : (statements[i] !== undefined ? statements[i] : sql);
      if (stmt) section.appendChild(this._queryHeader(stmt, set));
      const rowRef = this._tableRef(stmt || sql);

      const meta = document.createElement('div');
      meta.className = 'mb-2 text-sm text-base-content/60';
      const label = sets.length > 1 ? 'Result ' + (i + 1) + ' — ' : '';
      meta.textContent = label + set.rows.length + ' row(s)' + (set.truncated ? ' (showing first 1000)' : '');
      section.appendChild(meta);

      const box = document.createElement('div');
      box.className = 'rounded-lg border border-base-300';
      const table = document.createElement('table');
      table.className = 'table table-zebra table-sm';

      const thead = document.createElement('thead');
      thead.className = 'sticky top-0 z-10 bg-base-200';
      const htr = document.createElement('tr');
      const sortState = { col: null, dir: 1 };
      const colFilters = {};
      const ths = {};

      // Client-side per-column filtering of the result set. Each active filter
      // is a case-insensitive substring match; multiple columns are ANDed.
      const filterRows = (rows) => {
        const active = Object.entries(colFilters).filter(([, v]) => v !== '');
        if (!active.length) return rows;
        return rows.filter(row => active.every(([col, val]) => {
          const cell = row[col];
          const s = (cell === null || cell === undefined ? '' : String(cell)).toLowerCase();
          return s.includes(val.toLowerCase());
        }));
      };

      // Header label mode: column name, sort arrow, and a filter toggle icon
      // (tinted when a filter is active). Clicking the th (outside the icon)
      // still sorts as before.
      const showLabel = (th, c) => {
        th.innerHTML = '';
        const inner = document.createElement('span');
        inner.className = 'flex items-center justify-between gap-2 w-full';
        const left = document.createElement('span');
        left.className = 'inline-flex items-center gap-1';
        const lbl = document.createElement('span');
        lbl.textContent = c;
        const arrow = document.createElement('span');
        arrow.className = 'text-base-content/40 text-xs';
        arrow.textContent = sortState.col === c ? (sortState.dir === 1 ? '▲' : '▼') : '';
        left.append(lbl, arrow);
        const fbtn = document.createElement('button');
        fbtn.type = 'button';
        fbtn.className = 'btn btn-ghost btn-xs btn-square';
        const active = !!colFilters[c];
        fbtn.title = active ? ('Filter: ' + colFilters[c]) : 'Filter this column';
        fbtn.innerHTML = '<i data-lucide="filter" class="size-3' + (active ? ' text-primary' : '') + '"></i>';
        fbtn.addEventListener('click', (e) => { e.stopPropagation(); showInput(th, c); });
        const right = document.createElement('span');
        right.className = 'inline-flex items-center gap-1';
        right.appendChild(fbtn);
        if (active) {
          const clr = document.createElement('button');
          clr.type = 'button';
          clr.className = 'btn btn-ghost btn-xs btn-square';
          clr.title = 'Clear filter';
          clr.innerHTML = '<i data-lucide="filter-x" class="size-3 text-error"></i>';
          clr.addEventListener('click', (e) => { e.stopPropagation(); delete colFilters[c]; showLabel(th, c); renderRows(); });
          right.appendChild(clr);
        }
        inner.append(left, right);
        th.appendChild(inner);
        th._arrow = arrow;
        if (window.lucide) window.lucide.createIcons({ root: th });
      };

      // Header input mode: a text field to type a filter value plus an X to
      // cancel. Enter applies the filter; X (or Escape) exits, clearing any
      // active filter for the column.
      const showInput = (th, c) => {
        th.innerHTML = '';
        const inner = document.createElement('span');
        inner.className = 'inline-flex items-center gap-1';
        inner.addEventListener('click', (e) => e.stopPropagation());
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'input input-xs input-bordered w-14';
        input.placeholder = 'Filter…';
        input.value = colFilters[c] || '';
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'btn btn-ghost btn-xs btn-square';
        x.title = 'Cancel filter';
        x.innerHTML = '<i data-lucide="x" class="size-3.5"></i>';
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            const val = input.value.trim();
            if (val) colFilters[c] = val; else delete colFilters[c];
            showLabel(th, c);
            renderRows();
          } else if (e.key === 'Escape') {
            const had = !!colFilters[c];
            delete colFilters[c];
            showLabel(th, c);
            if (had) renderRows();
          }
        });
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          const had = !!colFilters[c];
          delete colFilters[c];
          showLabel(th, c);
          if (had) renderRows();
        });
        inner.append(input, x);
        th.appendChild(inner);
        if (window.lucide) window.lucide.createIcons({ root: th });
        input.focus();
      };

      set.columns.forEach(c => {
        const th = document.createElement('th');
        th.className = 'bg-base-200 cursor-pointer select-none hover:bg-base-300';
        ths[c] = th;
        th.addEventListener('click', () => {
          if (sortState.col === c) {
            sortState.dir = -sortState.dir;
          } else {
            sortState.col = c;
            sortState.dir = 1;
          }
          Object.keys(ths).forEach(k => showLabel(ths[k], k));
          renderRows();
        });
        showLabel(th, c);
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      const compare = (a, b) => {
        const av = a[sortState.col];
        const bv = b[sortState.col];
        const an = av === null || av === undefined || av === '';
        const bn = bv === null || bv === undefined || bv === '';
        if (an && bn) return 0;
        if (an) return 1;
        if (bn) return -1;
        const na = Number(av), nb = Number(bv);
        if (!Number.isNaN(na) && !Number.isNaN(nb) && av !== true && bv !== true) {
          return (na - nb) * sortState.dir;
        }
        return String(av).localeCompare(String(bv)) * sortState.dir;
      };
      const renderRows = () => {
        if (ctx.selectRow) ctx.selectRow(null);
        tbody.innerHTML = '';
        let rows = filterRows(set.rows);
        if (sortState.col) rows = rows.slice().sort(compare);
        rows.forEach(row => {
          const tr = document.createElement('tr');
          tr.className = 'hover:bg-base-300 cursor-pointer';
          tr._row = row;
          tr._table = rowRef;
          set.columns.forEach(c => {
            const td = document.createElement('td');
            td.className = 'max-w-xs break-words whitespace-normal';
            const v = row[c];
            td.textContent = v === null || v === undefined ? '' : String(v);
            tr.appendChild(td);
          });
          tr.addEventListener('click', () => {
            ctx.selectRow(ctx.selectedRow === tr ? null : tr);
          });
          tbody.appendChild(tr);
        });
      };
      renderRows();
      table.appendChild(tbody);
      box.appendChild(table);
      section.appendChild(box);
      results.appendChild(section);
      ctx.sections.push(section);
    });

    if (ctx.updateOverlay) ctx.updateOverlay();
  },

  // Maps a SQL Server type name to the best-fit HTML input type.
  _inputTypeFor(sqlType) {
    const t = String(sqlType || '').toLowerCase();
    if (['bit'].includes(t)) return 'checkbox';
    if (['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric',
      'float', 'real', 'money', 'smallmoney'].includes(t)) return 'number';
    if (['date'].includes(t)) return 'date';
    if (['time'].includes(t)) return 'time';
    if (['datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'].includes(t)) return 'datetime-local';
    return 'text';
  },

  // Formats a JS value as a SQL literal for the given SQL Server type.
  _sqlLiteral(value, sqlType) {
    if (value === null || value === undefined || value === '') return 'NULL';
    const t = String(sqlType || '').toLowerCase();
    if (t === 'bit') return value ? '1' : '0';
    const numeric = ['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric',
      'float', 'real', 'money', 'smallmoney'];
    if (numeric.includes(t) && value !== '' && !isNaN(Number(value))) return String(Number(value));
    return "'" + String(value).replace(/'/g, "''") + "'";
  },

  _qid(name) { return '[' + String(name).replace(/]/g, ']]') + ']'; },

  // Builds a localStorage key unique to the tab's context: the database, and —
  // for a table tab — the individual schema.table. This keeps each context's
  // SQL scratch contents separate and restores them after a refresh/remount.
  _storageKey(opts) {
    const db = (opts && opts.database) || '';
    const scope = opts && opts.table
      ? 't:' + (opts.schema || 'dbo') + '.' + opts.table
      : 'db';
    return 'sql-tab:' + db + ':' + scope;
  },

  // Fetches (and caches per table) the column types + FK option lists needed to
  // build edit/delete statements. Returns the metadata or null on failure.
  async _loadEditMeta(ctx, schema, table) {
    const opts = ctx.opts;
    const cacheKey = schema + '.' + table;
    ctx.editMetaByTable = ctx.editMetaByTable || {};
    if (!ctx.editMetaByTable[cacheKey]) {
      try {
        const res = await fetch('/api/edit-meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connectionString: opts.cs, database: opts.database,
            schema: schema, table: table,
          }),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || 'Failed to load table metadata');
        ctx.editMetaByTable[cacheKey] = d;
      } catch (e) {
        this._showError(ctx.results, (e && e.message) || 'Failed to load table metadata');
        return null;
      }
    }
    return ctx.editMetaByTable[cacheKey];
  },

  // Opens a modal to edit the selected row. Fields respect the column type;
  // foreign-key columns become selects populated from the referenced column.
  // The Update button appends the generated UPDATE statement to the editor.
  // `ref` = { schema, table } identifies the table to edit.
  async _openEditModal(ctx, row, ref) {
    const opts = ctx.opts;
    const schema = (ref && ref.schema) || opts.schema || 'dbo';
    const table = (ref && ref.table) || opts.table;
    if (!table) return;
    const meta = await this._loadEditMeta(ctx, schema, table);
    if (!meta) return;
    const colByName = {};
    (meta.columns || []).forEach(c => { colByName[c.name] = c; });
    const fkByName = {};
    (meta.fkOptions || []).forEach(f => { fkByName[f.column] = f; });

    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    const boxDiv = document.createElement('div');
    boxDiv.className = 'modal-box max-w-2xl';
    const title = document.createElement('h3');
    title.className = 'text-lg font-bold mb-4';
    title.textContent = 'Edit row — ' + table;
    boxDiv.appendChild(title);

    const form = document.createElement('div');
    form.className = 'grid grid-cols-1 gap-3';
    const inputs = {}; // column -> { el, type }

    Object.keys(row).forEach(col => {
      const colMeta = colByName[col];
      const sqlType = colMeta ? colMeta.type : '';
      const val = row[col];

      const field = document.createElement('label');
      field.className = 'form-control w-full';
      const lbl = document.createElement('div');
      lbl.className = 'label py-1';
      const lblText = document.createElement('span');
      lblText.className = 'label-text font-medium';
      lblText.textContent = col + (sqlType ? ' (' + sqlType + ')' : '');
      lbl.appendChild(lblText);
      field.appendChild(lbl);

      const fk = fkByName[col];
      if (fk) {
        const sel = document.createElement('select');
        sel.className = 'select select-bordered select-sm w-full';
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '(null)';
        sel.appendChild(empty);
        (fk.values || []).forEach(v => {
          const o = document.createElement('option');
          o.value = String(v);
          o.textContent = String(v);
          if (val !== null && val !== undefined && String(val) === String(v)) o.selected = true;
          sel.appendChild(o);
        });
        field.appendChild(sel);
        inputs[col] = { el: sel, type: sqlType, fk: true };
      } else {
        const inputType = this._inputTypeFor(sqlType);
        if (inputType === 'checkbox') {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'toggle toggle-sm';
          cb.checked = val === true || val === 1 || val === '1';
          field.appendChild(cb);
          inputs[col] = { el: cb, type: sqlType, checkbox: true };
        } else {
          const inp = document.createElement('input');
          inp.type = inputType;
          inp.className = 'input input-bordered input-sm w-full';
          inp.value = val === null || val === undefined ? '' : String(val);
          field.appendChild(inp);
          inputs[col] = { el: inp, type: sqlType };
        }
      }
      form.appendChild(field);
    });
    boxDiv.appendChild(form);

    const action = document.createElement('div');
    action.className = 'modal-action';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => dialog.close());
    const updateBtn = document.createElement('button');
    updateBtn.type = 'button';
    updateBtn.className = 'btn btn-primary';
    updateBtn.textContent = 'Update';
    updateBtn.addEventListener('click', () => {
      const sql = this._buildUpdateSql(row, inputs, colByName, schema, table);
      if (sql) {
        const cur = window.SqlEditor.getValue(ctx.view);
        const next = cur.trim() ? cur.replace(/\s*$/, '') + '\n\n' + sql : sql;
        window.SqlEditor.setValue(ctx.view, next);
        if (ctx.persist) ctx.persist();
      }
      dialog.close();
    });
    action.append(closeBtn, updateBtn);
    boxDiv.appendChild(action);

    dialog.appendChild(boxDiv);
    const backdrop = document.createElement('form');
    backdrop.method = 'dialog';
    backdrop.className = 'modal-backdrop';
    const bd = document.createElement('button');
    bd.textContent = 'close';
    backdrop.appendChild(bd);
    dialog.appendChild(backdrop);

    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  },

  // Builds an UPDATE statement from the edited inputs. The WHERE clause uses the
  // primary-key columns (or all original values if the table has no PK).
  _buildUpdateSql(row, inputs, colByName, schema, table) {
    const pkCols = Object.values(colByName).filter(c => c.isPrimaryKey).map(c => c.name);
    const whereCols = pkCols.length ? pkCols : Object.keys(row);
    const setCols = Object.keys(inputs).filter(c => !whereCols.includes(c) || !pkCols.length);

    const readInput = (info) => {
      if (info.checkbox) return info.el.checked ? 1 : 0;
      const v = info.el.value;
      return v === '' ? null : v;
    };

    const setParts = setCols.map(col => {
      const info = inputs[col];
      const type = (colByName[col] && colByName[col].type) || info.type;
      return '    ' + this._qid(col) + ' = ' + this._sqlLiteral(readInput(info), type);
    });
    const whereParts = whereCols.map(col => {
      const type = colByName[col] ? colByName[col].type : '';
      return this._qid(col) + ' = ' + this._sqlLiteral(row[col], type);
    });
    if (!setParts.length) return '';
    return 'UPDATE ' + this._qid(schema) + '.' + this._qid(table) + '\nSET\n' +
      setParts.join(',\n') + '\nWHERE ' + whereParts.join(' AND ') + ';';
  },

  // Confirms deletion of the selected row, then appends a DELETE statement to
  // the editor. The WHERE clause uses the primary key (or all original values).
  async _openDeleteModal(ctx, row, ref) {
    const opts = ctx.opts;
    const schema = (ref && ref.schema) || opts.schema || 'dbo';
    const table = (ref && ref.table) || opts.table;
    if (!table) return;
    const meta = await this._loadEditMeta(ctx, schema, table);
    if (!meta) return;
    const colByName = {};
    (meta.columns || []).forEach(c => { colByName[c.name] = c; });
    const sql = this._buildDeleteSql(row, colByName, schema, table);
    if (!sql) return;

    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    const boxDiv = document.createElement('div');
    boxDiv.className = 'modal-box';
    const title = document.createElement('h3');
    title.className = 'text-lg font-bold text-error flex items-center gap-2';
    title.innerHTML = '<i data-lucide="trash" class="size-5"></i>Delete record';
    boxDiv.appendChild(title);
    const msg = document.createElement('p');
    msg.className = 'py-4';
    msg.textContent = 'This will permanently delete the selected record from ' + table +
      '. This action cannot be undone. Continue?';
    boxDiv.appendChild(msg);
    const pre = document.createElement('pre');
    pre.className = 'rounded-lg bg-base-200 p-2 text-xs overflow-auto font-mono';
    pre.textContent = sql;
    boxDiv.appendChild(pre);

    const action = document.createElement('div');
    action.className = 'modal-action';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Cancel';
    closeBtn.addEventListener('click', () => dialog.close());
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-error';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      const cur = window.SqlEditor.getValue(ctx.view);
      const next = cur.trim() ? cur.replace(/\s*$/, '') + '\n\n' + sql : sql;
      window.SqlEditor.setValue(ctx.view, next);
      if (ctx.persist) ctx.persist();
      dialog.close();
    });
    action.append(closeBtn, delBtn);
    boxDiv.appendChild(action);

    dialog.appendChild(boxDiv);
    const backdrop = document.createElement('form');
    backdrop.method = 'dialog';
    backdrop.className = 'modal-backdrop';
    const bd = document.createElement('button');
    bd.textContent = 'close';
    backdrop.appendChild(bd);
    dialog.appendChild(backdrop);

    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    if (window.lucide) window.lucide.createIcons({ root: boxDiv });
    dialog.showModal();
  },

  // Builds a DELETE statement for one row. The WHERE clause uses the primary-key
  // columns (or all original values if the table has no PK).
  _buildDeleteSql(row, colByName, schema, table) {
    const pkCols = Object.values(colByName).filter(c => c.isPrimaryKey).map(c => c.name);
    const whereCols = pkCols.length ? pkCols : Object.keys(row);
    const whereParts = whereCols.map(col => {
      const type = colByName[col] ? colByName[col].type : '';
      return this._qid(col) + ' = ' + this._sqlLiteral(row[col], type);
    });
    if (!whereParts.length) return '';
    return 'DELETE FROM ' + this._qid(schema) + '.' + this._qid(table) +
      '\nWHERE ' + whereParts.join(' AND ') + ';';
  },

  // Best-effort parse of the primary table from a SELECT statement's FROM
  // clause. Returns { schema, table } or null. Handles [..], "..", `..` quoting
  // and optional schema/db qualification.
  _tableRef(sql) {
    if (!sql) return null;
    const m = /\bfrom\s+((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$#]+)(?:\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$#]+))*)/i.exec(sql);
    if (!m) return null;
    const parts = m[1].split('.').map(p =>
      p.trim().replace(/^[[\"`]/, '').replace(/[\]\"`]$/, '').trim()
    ).filter(Boolean);
    if (!parts.length) return null;
    const table = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2] : 'dbo';
    return { schema, table };
  },
};
