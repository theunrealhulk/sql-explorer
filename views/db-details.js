// <db-details> — a 3-tab element (Tables, Relations, SQL) shown when only a
// database (no table) is selected. The Tables tab lists the database's tables
// with SQL-level sorting and pagination (fetched from /api/tables). Renders in
// the light DOM so global daisyUI/Tailwind styles apply.

// Per-database relations view state (expanded nodes, zoom transform, search),
// kept alive across mounts so returning to a database via history restores it.
// Also persisted to localStorage so the state survives a full page refresh.
const DB_REL_STATE = new Map();
const DB_REL_STATE_KEY = 'sql-explorer-relstate';

// Rehydrate any persisted relations state on load.
try {
  const raw = localStorage.getItem(DB_REL_STATE_KEY);
  if (raw) {
    const obj = JSON.parse(raw);
    for (const [db, s] of Object.entries(obj || {})) {
      DB_REL_STATE.set(db, {
        expanded: new Set(Array.isArray(s.expanded) ? s.expanded : []),
        search: typeof s.search === 'string' ? s.search : '',
        transform: s.transform || null,
      });
    }
  }
} catch (_) { /* ignore corrupt state */ }

// Serializes DB_REL_STATE (Sets -> arrays) to localStorage.
function persistRelState() {
  if (window.saveEnabled && !window.saveEnabled('dbRelations')) return;
  try {
    const obj = {};
    for (const [db, s] of DB_REL_STATE) {
      obj[db] = {
        expanded: [...(s.expanded || [])],
        search: s.search || '',
        transform: s.transform || null,
      };
    }
    localStorage.setItem(DB_REL_STATE_KEY, JSON.stringify(obj));
  } catch (_) { /* ignore quota/serialisation errors */ }
}

class DbDetails extends HTMLElement {
  constructor() {
    super();
    this.page = 1;
    this.pageSize = 20;
    this.sortKey = 'name';
    this.sortDir = 'ASC';
    this._colFilters = {};
    this._filterTimer = null;
    this._uid = 'db-' + Math.random().toString(36).slice(2);
    this._relLoaded = false;
    this._search = '';
  }

  get cs() { return this.getAttribute('cs') || ''; }
  get database() { return this.getAttribute('database') || ''; }

  connectedCallback() {
    this.renderShell();
    this.loadTablesState();
    this.buildTablesPanel();
    this.loadTables();
    if ((localStorage.getItem('db-tab') || 'Tables') === 'Relations') this.loadRelations();
  }

  disconnectedCallback() {
    if (this._relSim) { this._relSim.stop(); this._relSim = null; }
    if (this._keyHandler) {
      window.removeEventListener('keydown', this._keyHandler);
      window.removeEventListener('keyup', this._keyHandler);
      this._keyHandler = null;
    }
    if (this._isolatedOutsideHandler) {
      document.removeEventListener('click', this._isolatedOutsideHandler);
      this._isolatedOutsideHandler = null;
    }
    if (this._tableModal) {
      this._tableModal.remove();
      this._tableModal = null;
    }
    if (this._sqlCtrl) { this._sqlCtrl.destroy(); this._sqlCtrl = null; }
    this._sqlTab = false;
  }

  async api(path, body) {
    const res = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // Persist the Tables tab's filter/sort/pagination per database so the view is
  // restored after a full page refresh.
  tablesStateKey() { return 'sql-explorer-dbtables:' + this.database; }

  loadTablesState() {
    try {
      const raw = localStorage.getItem(this.tablesStateKey());
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.colFilters && typeof s.colFilters === 'object') this._colFilters = s.colFilters;
      if (typeof s.sortKey === 'string') this.sortKey = s.sortKey;
      if (s.sortDir === 'ASC' || s.sortDir === 'DESC') this.sortDir = s.sortDir;
      if (Number.isInteger(s.page) && s.page > 0) this.page = s.page;
      if ([20, 50, 100, 200, 500].includes(s.pageSize)) this.pageSize = s.pageSize;
      if (typeof s.lastFilterKey === 'string') this._lastFilterKey = s.lastFilterKey;
      if (typeof s.search === 'string') this._search = s.search;
    } catch (_) { /* ignore corrupt state */ }
  }

  saveTablesState() {
    if (window.saveEnabled && !window.saveEnabled('dbTables')) return;
    try {
      localStorage.setItem(this.tablesStateKey(), JSON.stringify({
        colFilters: this._colFilters,
        sortKey: this.sortKey,
        sortDir: this.sortDir,
        page: this.page,
        pageSize: this.pageSize,
        lastFilterKey: this._lastFilterKey || '',
        search: this._search || '',
      }));
    } catch (_) { /* ignore quota/serialisation errors */ }
  }

  renderShell() {
    const panel = 'tab-content bg-base-100 border-base-300 p-4';
    const saved = localStorage.getItem('db-tab') || 'Tables';
    const tabs = ['Tables', 'Relations', 'SQL'];
    const active = tabs.includes(saved) ? saved : 'Tables';
    const tab = (label, panelName, body) =>
      '<input type="radio" name="' + this._uid + '" role="tab" class="tab" aria-label="' + label + '"' +
        (label === active ? ' checked' : '') + ' />' +
      '<div role="tabpanel" class="' + panel + '" data-panel="' + panelName + '">' + (body || '') + '</div>';
    this.innerHTML =
      '<div role="tablist" class="tabs tabs-lift">' +
        tab('Tables', 'tables', '') +
        tab('Relations', 'relations', '') +
        tab('SQL', 'sql', '') +
      '</div>';
    this.querySelectorAll('input[role="tab"]').forEach(input => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        const label = input.getAttribute('aria-label');
        localStorage.setItem('db-tab', label);
        if (label === 'Relations' && !this._relLoaded) this.loadRelations();
        if (label === 'SQL') this.loadSqlTab();
      });
    });
    if (active === 'SQL') this.loadSqlTab();
    if (window.updateCrumbActions) window.updateCrumbActions();
  }

  // Exposes a small controller so an external UI (the breadcrumb action
  // buttons) can drive tab switching.
  get tabController() {
    const self = this;
    const tabs = ['Tables', 'Relations', 'SQL'];
    return {
      tabs: () => tabs,
      activeTab: () => {
        const checked = self.querySelector('input[role="tab"]:checked');
        return checked ? checked.getAttribute('aria-label') : tabs[0];
      },
      select: (label) => {
        const input = self.querySelector('input[role="tab"][aria-label="' + label + '"]');
        if (!input) return;
        input.checked = true;
        input.dispatchEvent(new Event('change'));
      },
    };
  }

  // Mounts the shared editable SQL editor into the SQL tab, once.
  loadSqlTab() {
    if (this._sqlTab || !window.SqlScratchTab) return;
    const target = this.panel('sql');
    if (!target) return;
    this._sqlTab = true;
    window.SqlScratchTab.mount(target, { cs: this.cs, database: this.database })
      .then(ctrl => { this._sqlCtrl = ctrl; });
  }

  panel(name) {
    return this.querySelector('[data-panel="' + name + '"]');
  }

  info(target, text) {
    target.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'text-base-content/60';
    p.textContent = text;
    target.appendChild(p);
  }

  error(target, text) {
    target.innerHTML = '';
    const div = document.createElement('div');
    div.setAttribute('role', 'alert');
    div.className = 'alert alert-error alert-soft';
    div.textContent = text;
    target.appendChild(div);
  }

  // Empty-results state for the Tables tab. If column filters are active, shows
  // a "Clear filters" button so a filter matching nothing can still be reset
  // (the table headers, which hold the clear icons, aren't rendered).
  emptyTables(target) {
    target.innerHTML = '';
    const active = Object.keys(this._colFilters).filter(k => this._colFilters[k]);
    if (!active.length) { this.info(target, 'No tables.'); return; }
    const wrap = document.createElement('div');
    wrap.className = 'flex items-center gap-3';
    const p = document.createElement('p');
    p.className = 'text-base-content/60';
    p.textContent = 'No tables match the active filter.';
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-ghost text-error';
    btn.innerHTML = '<i data-lucide="filter-x" class="size-4"></i> Clear filters';
    btn.addEventListener('click', () => {
      this._colFilters = {};
      this.page = 1;
      this.loadTables();
    });
    wrap.appendChild(p);
    wrap.appendChild(btn);
    target.appendChild(wrap);
    if (window.lucide) window.lucide.createIcons({ root: wrap });
  }

  // Builds the results container once. Per-column filtering lives in the table
  // headers (see renderTables), mirroring the Data tab.
  buildTablesPanel() {
    const panel = this.panel('tables');
    if (!panel) return;
    panel.innerHTML = '';

    // Persistent "find in all columns" search bar, mirroring the table Data tab.
    const bar = document.createElement('div');
    bar.className = 'mb-3 flex flex-wrap items-center gap-3';

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'input input-bordered input-lg grow';
    input.placeholder = 'Find tables containing a column named…';
    input.value = this._search || '';
    input.addEventListener('input', () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this._search = input.value.trim();
        this.page = 1;
        this.loadTables();
      }, 300);
    });

    bar.appendChild(input);
    panel.appendChild(bar);

    const results = document.createElement('div');
    results.setAttribute('data-results', '');
    panel.appendChild(results);
  }

  results() {
    const panel = this.panel('tables');
    return panel ? panel.querySelector('[data-results]') : null;
  }

  async loadTables() {
    const target = this.results();
    if (!target) return;
    this.saveTablesState();
    // Skip the "Loading…" clear while live-filtering the name column so the
    // focused input isn't torn out of the DOM mid-keystroke.
    if (!this._reopenFilter) this.info(target, 'Loading tables…');
    const d = await this.api('tables', {
      connectionString: this.cs,
      database: this.database,
      sort: this.sortKey,
      dir: this.sortDir,
      page: this.page,
      pageSize: this.pageSize,
      columnFilters: this._colFilters,
      search: this._search,
    });
    if (!d.ok) { this.error(target, d.error); return; }
    this.renderTables(target, d);
  }

  renderTables(target, d) {
    target.innerHTML = '';

    const columns = [
      { key: 'name', label: 'Table name' },
      { key: 'fieldCount', label: 'Fields' },
      { key: 'rowCount', label: 'Rows' },
      { key: 'fkCount', label: 'Uses referencing tables' },
      { key: 'referencedByCount', label: 'Used by other tables' },
    ];
    this._columns = columns;

    if (!(d.tables || []).length) {
      this.emptyTables(target);
      return;
    }

    const totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));

    const wrap = document.createElement('div');
    wrap.className = 'overflow-x-auto';
    if (Object.values(this._colFilters).some(v => v)) wrap.classList.add('filter-active-border');
    const table = document.createElement('table');
    table.className = 'table table-zebra table-sm';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    // If the last applied filter (before a reload/remount) was on the table
    // name, re-open its filter input focused so the user can keep typing.
    if (!this._reopenFilter && this._lastFilterKey === 'name' && !this._focusedNameOnce) {
      this._focusedNameOnce = true;
      const v = this._colFilters.name || '';
      this._reopenFilter = { key: 'name', value: v, caret: v.length };
    }
    columns.forEach(col => {
      const th = document.createElement('th');
      this.renderHeaderLabel(th, col);
      htr.appendChild(th);
      // When searching by column name, show a "Matches" column right after the
      // table name listing the columns that matched the typed value.
      if (col.key === 'name' && this._search) {
        const mth = document.createElement('th');
        mth.className = 'text-info border-2 border-warning';
        mth.textContent = 'Matched columns';
        htr.appendChild(mth);
      }
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const yesNo = (v) => {
      const badge = document.createElement('span');
      badge.className = 'badge badge-sm ' + (v ? 'badge-success' : 'badge-ghost');
      badge.textContent = v ? 'Yes' : 'No';
      return badge;
    };

    const tbody = document.createElement('tbody');
    (d.tables || []).forEach(t => {
      const tr = document.createElement('tr');

      const name = document.createElement('td');
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'font-bold link link-hover';
      link.textContent = t.name;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof selectTable === 'function') selectTable(this.database, t);
      });
      name.appendChild(link);

      const fields = document.createElement('td');
      fields.textContent = t.fieldCount != null ? t.fieldCount : 0;

      const rowsTd = document.createElement('td');
      rowsTd.textContent = (t.rowCount || 0).toLocaleString();

      const uses = document.createElement('td');
      uses.appendChild(yesNo((t.fkCount || 0) > 0));

      const usedBy = document.createElement('td');
      usedBy.appendChild(yesNo((t.referencedByCount || 0) > 0));

      tr.appendChild(name);
      if (this._search) {
        const matchTd = document.createElement('td');
        matchTd.className = 'text-info font-bold border-2 border-warning';
        matchTd.textContent = t.matchedColumns || '';
        tr.appendChild(matchTd);
      }
      tr.appendChild(fields);
      tr.appendChild(rowsTd);
      tr.appendChild(uses);
      tr.appendChild(usedBy);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    target.appendChild(wrap);

    target.appendChild(this.pagination(d, totalPages));

    // Now that the grid is attached to the document, focus the filter input we
    // re-opened (focusing a detached element above is a no-op).
    if (this._pendingFocusInput) {
      const input = this._pendingFocusInput;
      const pos = this._pendingFocusCaret;
      this._pendingFocusInput = null;
      requestAnimationFrame(() => {
        if (!input.isConnected) return;
        input.focus();
        try { input.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
      });
    }
  }

  // Column header in label mode: sortable column name plus a filter toggle
  // icon (tinted when active) and a clear icon. Mirrors the Data tab.
  renderHeaderLabel(th, col) {
    const c = col.key;
    // If this column was being live-filtered as the user typed, re-open its
    // input (restoring the value and caret) instead of showing the label.
    if (this._reopenFilter && this._reopenFilter.key === c) {
      const state = this._reopenFilter;
      this._reopenFilter = null;
      this.renderHeaderInput(th, col);
      const input = th.querySelector('input');
      if (input) {
        input.value = state.value;
        const pos = state.caret == null ? state.value.length : state.caret;
        try { input.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
        input.focus();
        // The header may still be detached from the document at this point
        // (the table is built in memory and appended later), so calling focus()
        // now can be a no-op. Re-focus on the next frame once it's attached.
        this._pendingFocusInput = input;
        this._pendingFocusCaret = pos;
      }
      return;
    }
    th.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'flex items-center justify-between gap-2';
    const label = document.createElement('span');
    label.className = 'inline-flex cursor-pointer select-none items-center gap-1 font-bold hover:text-primary';
    label.title = 'Sort by ' + col.label;
    const name = document.createElement('span');
    name.textContent = col.label;
    const arrow = document.createElement('span');
    arrow.className = 'text-base-content/40 text-xs';
    arrow.textContent = this.sortKey === c ? (this.sortDir === 'ASC' ? '\u25B2' : '\u25BC') : '';
    label.append(name, arrow);
    label.addEventListener('click', () => {
      if (this.sortKey === c) this.sortDir = this.sortDir === 'ASC' ? 'DESC' : 'ASC';
      else { this.sortKey = c; this.sortDir = 'ASC'; }
      this.page = 1;
      this.loadTables();
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-xs btn-square';
    const active = !!this._colFilters[c];
    btn.title = active ? ('Filter: ' + this._colFilters[c]) : 'Filter this column';
    btn.innerHTML = '<i data-lucide="filter" class="size-3' + (active ? ' text-primary' : '') + '"></i>';
    btn.addEventListener('click', () => this.renderHeaderInput(th, col));
    const right = document.createElement('div');
    right.className = 'flex items-center gap-1';
    right.appendChild(btn);
    if (active) {
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'btn btn-ghost btn-xs btn-square';
      clr.title = 'Clear filter';
      clr.innerHTML = '<i data-lucide="filter-x" class="size-3 text-error"></i>';
      clr.addEventListener('click', () => { delete this._colFilters[c]; this.page = 1; this.loadTables(); });
      right.appendChild(clr);
    }
    box.append(label, right);
    th.appendChild(box);
    if (window.lucide) window.lucide.createIcons({ root: th });
  }

  // Column header in input mode: a text field to type a filter value plus an X
  // to cancel. Enter applies the filter; X (or Escape) exits. Mirrors the Data tab.
  renderHeaderInput(th, col) {
    const c = col.key;
    th.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'flex items-center gap-1';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input input-xs input-bordered w-20';
    const opCol = c !== 'name';
    input.placeholder = opCol ? '=,>,<  [1,5]  (1,2)' : 'Filter…';
    input.title = opCol
      ? 'Operators: =, >, <, >=, <=, ! (default =)\nRange: [min,max]\nList: (v1,v2,v3)'
      : 'Filter this column';
    input.value = this._colFilters[c] || '';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'btn btn-ghost btn-xs btn-square';
    x.title = 'Cancel filter';
    x.innerHTML = '<i data-lucide="x" class="size-3.5"></i>';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        if (val) this._colFilters[c] = val;
        else delete this._colFilters[c];
        this._lastFilterKey = c;
        this.page = 1;
        this.loadTables();
      } else if (e.key === 'Escape') {
        this.exitHeaderFilter(th, col);
      }
    });
    x.addEventListener('click', () => this.exitHeaderFilter(th, col));
    box.append(input, x);
    th.appendChild(box);
    if (window.lucide) window.lucide.createIcons({ root: th });
    input.focus();

    // The table name filters live as you type. Because loadTables() re-renders
    // the whole grid (and its headers), remember this column so renderHeaderLabel
    // re-opens the input with focus and the caret restored after each reload.
    if (c === 'name') {
      input.addEventListener('input', () => {
        clearTimeout(this._nameFilterTimer);
        const val = input.value;
        const caret = input.selectionStart;
        this._nameFilterTimer = setTimeout(() => {
          const v = val.trim();
          if (v) this._colFilters[c] = v;
          else delete this._colFilters[c];
          this.page = 1;
            this._reopenFilter = { key: c, value: val, caret };
            this._lastFilterKey = c;
            this.loadTables();
        }, 250);
      });
    }
  }

  // Exits filter-input mode: clears any active filter for the column and
  // re-queries when that changed the result, otherwise restores the label.
  exitHeaderFilter(th, col) {
    const c = col.key;
    const had = !!this._colFilters[c];
    if (had) { delete this._colFilters[c]; this.page = 1; this.loadTables(); }
    else this.renderHeaderLabel(th, col);
  }

  pagination(d, totalPages) {
    const bar = document.createElement('div');
    bar.className = 'mt-3 flex items-center justify-between gap-2 flex-wrap';

    const left = document.createElement('div');
    left.className = 'flex items-center gap-2';

    const join = document.createElement('div');
    join.className = 'join';

    const prev = document.createElement('button');
    prev.className = 'btn btn-sm join-item';
    prev.textContent = 'Prev';
    prev.disabled = d.page <= 1;
    prev.addEventListener('click', () => { this.page = d.page - 1; this.loadTables(); });

    const next = document.createElement('button');
    next.className = 'btn btn-sm join-item';
    next.textContent = 'Next';
    next.disabled = d.page >= totalPages;
    next.addEventListener('click', () => { this.page = d.page + 1; this.loadTables(); });

    join.appendChild(prev);
    join.appendChild(next);

    const info = document.createElement('span');
    info.className = 'text-sm text-base-content/60';
    info.textContent = 'Page ' + d.page + ' of ' + totalPages + ' — ' + d.total.toLocaleString() + ' tables';

    left.appendChild(join);
    left.appendChild(info);

    bar.appendChild(left);
    bar.appendChild(this.pageSizeSelector());
    return bar;
  }

  // Page-size buttons (opposite side of pagination).
  pageSizeSelector() {
    const group = document.createElement('div');
    group.className = 'join';
    [20, 50, 100, 200, 500].forEach(size => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm join-item' + (this.pageSize === size ? ' btn-active btn-primary' : '');
      btn.textContent = String(size);
      btn.addEventListener('click', () => {
        if (this.pageSize === size) return;
        this.pageSize = size;
        this.page = 1;
        this.loadTables();
      });
      group.appendChild(btn);
    });
    return group;
  }

  // ---- Relations tab -----------------------------------------------------
  async loadRelations() {
    const target = this.panel('relations');
    if (!target) return;
    this.info(target, 'Loading relations…');
    const d = await this.api('db-relations', {
      connectionString: this.cs,
      database: this.database,
    });
    if (!d.ok) { this.error(target, d.error); return; }
    this._relLoaded = true;
    this.buildRelationsModel(d);
    this.renderRelations(target, d);
  }

  // Builds adjacency maps and the initial set of root nodes (tables that are
  // not referenced by any other table).
  buildRelationsModel(d) {
    const edges = (d.edges || []).filter(e => e.from && e.to && e.from !== e.to);
    this._edges = edges;
    this._children = new Map();   // table -> [tables it references]
    const all = new Set();
    const targets = new Set();    // tables referenced by someone
    edges.forEach(e => {
      all.add(e.from); all.add(e.to);
      targets.add(e.to);
      if (!this._children.has(e.from)) this._children.set(e.from, []);
      const arr = this._children.get(e.from);
      if (!arr.includes(e.to)) arr.push(e.to);
    });
    this._allNodes = all;
    let roots = new Set([...all].filter(id => !targets.has(id)));
    // Fully cyclic graph: fall back to any table that references others.
    if (!roots.size) roots = new Set([...this._children.keys()]);
    this._roots = roots;
    // Sub-nodes reachable (as a descendant) from more than one root are shared
    // across branches; they get a purple stroke so the overlap is visible.
    const rootHits = new Map();
    for (const r of roots) {
      const seen = new Set([r]);
      const stack = [...(this._children.get(r) || [])];
      const local = new Set();
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        local.add(id);
        for (const c of (this._children.get(id) || [])) if (!seen.has(c)) stack.push(c);
      }
      for (const id of local) rootHits.set(id, (rootHits.get(id) || 0) + 1);
    }
    this._multiRootNodes = new Set();
    for (const [id, n] of rootHits) if (n > 1) this._multiRootNodes.add(id);
    // Restore any previously saved expansion / search for this database.
    const cached = DB_REL_STATE.get(this.database);
    this._expanded = new Set(cached && cached.expanded ? cached.expanded : []);
    if (cached && typeof cached.search === 'string') this._search = cached.search;
    this._nodePos = new Map();
  }

  // Snapshots the current relations view (expanded nodes, zoom transform,
  // search text) so it can be restored when the element is re-created.
  saveRelState() {
    if (!this.database) return;
    let transform = null;
    if (this._relSvg && typeof d3 !== 'undefined') {
      const t = d3.zoomTransform(this._relSvg.node());
      transform = { k: t.k, x: t.x, y: t.y };
    }
    DB_REL_STATE.set(this.database, {
      expanded: new Set(this._expanded),
      search: this._search || '',
      transform,
    });
    persistRelState();
  }

  // Every node that has children (i.e. can be expanded/collapsed).
  expandableNodes() {
    const set = new Set();
    for (const [id, kids] of this._children) {
      if (kids && kids.length) set.add(id);
    }
    return set;
  }

  // True when every expandable node is currently expanded.
  allExpanded() {
    const parents = this.expandableNodes();
    if (!parents.size) return false;
    for (const id of parents) if (!this._expanded.has(id)) return false;
    return true;
  }

  // Syncs the toolbar toggle label to the current expansion state.
  updateExpandBtn() {
    if (!this._expandBtn) return;
    this._expandBtn.textContent = this.allExpanded() ? 'Collapse all' : 'Expand all';
  }

  // Toolbar action: expand every node's children, or collapse them all.
  toggleExpandAll() {
    this._expanded = this.allExpanded() ? new Set() : this.expandableNodes();
    this.saveRelState();
    this.drawGraph();
    this.updateExpandBtn();
  }

  // Reorders roots so that any that reference a common child table sit next to
  // each other. Roots are clustered (union-find) by shared direct children;
  // clusters — and roots within them — keep their original relative order.
  orderRoots(roots) {
    if (roots.length < 3) return roots;
    const parent = new Map();
    roots.forEach(r => parent.set(r, r));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    // Union every pair of roots that reference the same child table.
    const childOwner = new Map();
    roots.forEach(r => {
      for (const c of (this._children.get(r) || [])) {
        if (childOwner.has(c)) union(r, childOwner.get(c));
        else childOwner.set(c, r);
      }
    });
    // Group by cluster, emitting each cluster on its first appearance so both
    // the cluster order and the order within a cluster stay stable.
    const clusters = new Map();
    roots.forEach(r => {
      const k = find(r);
      if (!clusters.has(k)) clusters.set(k, []);
      clusters.get(k).push(r);
    });
    const ordered = [];
    const seen = new Set();
    roots.forEach(r => {
      const k = find(r);
      if (seen.has(k)) return;
      seen.add(k);
      ordered.push(...clusters.get(k));
    });
    return ordered;
  }

  // Visible nodes = roots plus the descendants of every expanded visible node.
  computeVisible() {
    const visible = new Set();
    const queue = [];
    for (const r of this._roots) { visible.add(r); queue.push(r); }
    while (queue.length) {
      const id = queue.shift();
      if (this._expanded.has(id)) {
        for (const c of (this._children.get(id) || [])) {
          if (!visible.has(c)) { visible.add(c); queue.push(c); }
        }
      }
    }
    return visible;
  }

  nodeColor(id) {
    if (this._roots.has(id)) return '#22c55e';                 // green — root
    const hasChildren = (this._children.get(id) || []).length > 0;
    return hasChildren ? '#f97316' : '#ef4444';               // orange / red
  }

  // Injects a themed, non-floating scrollbar for the isolated-tables list. The
  // global `:root{scrollbar-color:currentColor #0000}` rule forces every
  // scrollbar to a track-less pill; resetting `scrollbar-color:auto` here lets
  // the ::-webkit-scrollbar rules take effect so the track is visible and the
  // colors follow the current daisyUI theme (works in light and dark).
  ensureIsoScrollStyles() {
    if (document.getElementById('db-iso-scroll-style')) return;
    const style = document.createElement('style');
    style.id = 'db-iso-scroll-style';
    style.textContent =
      '.db-iso-scroll{scrollbar-color:auto;scrollbar-width:thin;scrollbar-gutter:stable both-edges}' +
      // daisyUI sets `padding-inline:.75rem` on each menu item via a :where()
      // rule (zero specificity); this class selector overrides it so the item
      // highlight aligns flush with the row instead of being inset.
      '.db-iso-scroll li > *{padding-inline:0}' +
      '.db-iso-scroll::-webkit-scrollbar{width:8px}' +
      '.db-iso-scroll::-webkit-scrollbar-track{background:var(--color-base-200,#e5e7eb);border-radius:8px}' +
      '.db-iso-scroll::-webkit-scrollbar-thumb{background:color-mix(in oklab,var(--color-base-content,#6b7280) 45%,transparent);' +
        'border-radius:8px;border:2px solid var(--color-base-200,#e5e7eb)}' +
      '.db-iso-scroll::-webkit-scrollbar-thumb:hover{background:color-mix(in oklab,var(--color-base-content,#6b7280) 65%,transparent)}';
    document.head.appendChild(style);
  }

  // Injects the blinking-stroke keyframes for search hits (once per document).
  ensureSearchStyles() {
    if (document.getElementById('db-rel-search-style')) return;
    const style = document.createElement('style');
    style.id = 'db-rel-search-style';
    style.textContent =
      '@keyframes dbRelBlink{0%,100%{stroke:#ffffff}50%{stroke:#38bdf8}}' +
      '.db-rel-hit{animation:dbRelBlink .8s ease-in-out infinite;stroke-width:3px}';
    document.head.appendChild(style);
  }

  // Expands every ancestor of `id` so the node becomes visible in the tree.
  expandToReveal(id) {
    if (!this._parentsMap) {
      this._parentsMap = new Map();
      this._edges.forEach(e => {
        if (!this._parentsMap.has(e.to)) this._parentsMap.set(e.to, []);
        this._parentsMap.get(e.to).push(e.from);
      });
    }
    const stack = [id];
    const seen = new Set([id]);
    while (stack.length) {
      const cur = stack.pop();
      for (const p of (this._parentsMap.get(cur) || [])) {
        this._expanded.add(p);
        if (!seen.has(p)) { seen.add(p); stack.push(p); }
      }
    }
  }

  // Returns true if `id` or any table reachable through its children contains
  // the (already-lowercased) search term. Used to hide unmatched root branches.
  subtreeMatches(id, term) {
    const stack = [id];
    const seen = new Set([id]);
    while (stack.length) {
      const cur = stack.pop();
      if (cur.toLowerCase().includes(term)) return true;
      for (const c of (this._children.get(cur) || [])) {
        if (!seen.has(c)) { seen.add(c); stack.push(c); }
      }
    }
    return false;
  }

  // Reveals and blinks all nodes whose name contains the current search text.
  applySearch() {
    const term = (this._search || '').toLowerCase();
    if (term) {
      [...this._allNodes]
        .filter(id => id.toLowerCase().includes(term))
        .forEach(id => this.expandToReveal(id));
      // Re-center on the filtered result so matches never end up off-screen.
      this._fitPending = true;
    }
    this.saveRelState();
    this.drawGraph();
  }

  // Measures a node label's pixel width (cached canvas) to size the pill.
  measureLabel(text, bold) {
    if (!this._measureCtx) {
      this._measureCtx = document.createElement('canvas').getContext('2d');
    }
    this._measureCtx.font = (bold ? '700 ' : '400 ') + '12px sans-serif';
    return this._measureCtx.measureText(text || '').width;
  }

  renderRelations(target, d) {
    target.innerHTML = '';
    target.style.position = 'relative';

    const isolated = d.isolatedCount || 0;
    const isolatedTables = d.isolatedTables || [];

    // Header: isolated-table dropdown (top-left) + legend.
    const header = document.createElement('div');
    header.className = 'mb-2 flex flex-wrap items-center justify-between gap-3';

    const countLabel = isolated + ' isolated table' + (isolated === 1 ? '' : 's') + ' (no relationships, hidden)';
    if (isolated) {
      const dropdown = document.createElement('details');
      dropdown.className = 'dropdown';
      const summary = document.createElement('summary');
      summary.className = 'btn btn-sm btn-ghost gap-1 text-warning';
      summary.textContent = countLabel;

      const content = document.createElement('div');
      content.className = 'dropdown-content z-20 mt-1 w-64 rounded-box border border-base-300 bg-base-100 shadow';

      const filter = document.createElement('input');
      filter.type = 'search';
      filter.placeholder = 'Filter tables\u2026';
      filter.className = 'input input-sm input-bordered mb-2 w-full';

      const list = document.createElement('ul');
      list.className = 'menu max-h-72 flex-nowrap overflow-y-auto db-iso-scroll';
      // The global `:root{scrollbar-color:currentColor #0000}` rule makes this
      // list's scrollbar a floating, track-less pill in every theme. Resetting
      // scrollbar-color to `auto` re-enables the themed ::-webkit-scrollbar
      // styling injected below (see ensureIsoScrollStyles).
      this.ensureIsoScrollStyles();

      const renderList = (q) => {
        list.innerHTML = '';
        const term = (q || '').toLowerCase();
        const matches = isolatedTables.filter(name => name.toLowerCase().includes(term));
        if (!matches.length) {
          const li = document.createElement('li');
          const span = document.createElement('span');
          span.className = 'text-base-content/50';
          span.textContent = 'No matches';
          li.appendChild(span);
          list.appendChild(li);
          return;
        }
        matches.forEach(name => {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.textContent = name;
          a.title = 'Open ' + name;
          a.addEventListener('click', () => {
            dropdown.open = false;
            this.openTableModal(name);
          });
          li.appendChild(a);
          list.appendChild(li);
        });
      };
      renderList('');
      filter.addEventListener('input', () => renderList(filter.value));
      // Focus the filter as soon as the dropdown opens.
      dropdown.addEventListener('toggle', () => { if (dropdown.open) filter.focus(); });

      content.append(filter, list);
      dropdown.append(summary, content);
      header.appendChild(dropdown);

      // Close the dropdown when clicking anywhere outside of it.
      if (this._isolatedOutsideHandler) document.removeEventListener('click', this._isolatedOutsideHandler);
      this._isolatedOutsideHandler = (e) => {
        if (dropdown.open && !dropdown.contains(e.target)) dropdown.open = false;
      };
      document.addEventListener('click', this._isolatedOutsideHandler);
    } else {
      const count = document.createElement('span');
      count.className = 'text-sm font-medium text-warning';
      count.textContent = countLabel;
      header.appendChild(count);
    }

    const legend = document.createElement('div');
    legend.className = 'flex flex-wrap gap-4 text-sm';
    [['#22c55e', 'Root (not referenced)'], ['#f97316', 'References other tables'], ['#ef4444', 'No further references']]
      .forEach(([c, label]) => {
        const item = document.createElement('span');
        item.className = 'flex items-center gap-2';
        const dot = document.createElement('span');
        dot.className = 'inline-block size-3 rounded-full';
        dot.style.backgroundColor = c;
        const txt = document.createElement('span');
        txt.textContent = label;
        item.append(dot, txt);
        legend.appendChild(item);
      });
    header.appendChild(legend);
    target.appendChild(header);

    if (!this._edges.length) {
      const p = document.createElement('p');
      p.className = 'text-base-content/60';
      p.textContent = 'No foreign-key relationships in this database.';
      target.appendChild(p);
      return;
    }
    if (typeof d3 === 'undefined') {
      const p = document.createElement('p');
      p.className = 'text-base-content/60';
      p.textContent = 'Graph library failed to load.';
      target.appendChild(p);
      return;
    }

    const hint = document.createElement('p');
    hint.className = 'mb-2 text-xs text-base-content/50';
    hint.textContent = 'Click a node to expand or collapse the tables it references. Ctrl+click to open a table.';
    target.appendChild(hint);

    // Toolbar: fit-to-screen button + live zoom percentage.
    const toolbar = document.createElement('div');
    toolbar.className = 'mb-2 flex items-center gap-3';
    const fitBtn = document.createElement('button');
    fitBtn.type = 'button';
    fitBtn.className = 'btn btn-xs';
    fitBtn.textContent = 'Fit to screen';
    fitBtn.addEventListener('click', () => this.fitToView());
    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'btn btn-xs';
    expandBtn.addEventListener('click', () => this.toggleExpandAll());
    this._expandBtn = expandBtn;
    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'text-xs font-medium text-base-content/60';
    zoomLabel.textContent = '100%';
    this._zoomLabel = zoomLabel;
    toolbar.append(fitBtn, expandBtn, zoomLabel);
    target.appendChild(toolbar);
    this.updateExpandBtn();

    const width = target.clientWidth || 800;
    const headerBottom = toolbar.getBoundingClientRect().bottom;
    const height = Math.max(360, Math.floor(window.innerHeight - headerBottom - 24));

    const svg = d3.create('svg')
      .attr('width', '100%')
      .attr('height', height)
      .attr('viewBox', [0, 0, width, height])
      .attr('class', 'w-full rounded-lg border border-base-300 bg-base-100')
      .attr('fill', 'currentColor');

    svg.append('defs').append('marker')
      .attr('id', 'db-rel-arrow-' + this._uid)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#94a3b8');

    this._relSvg = svg;
    this._relW = width;
    this._relH = height;
    this._relContent = null;

    // Search overlay: type a table name to reveal (auto-expand) and blink every
    // matching node. Sits just under the legend, floating over the graph.
    this.ensureSearchStyles();
    const searchWrap = document.createElement('div');
    searchWrap.className = 'absolute right-2 z-10';
    searchWrap.style.top = (svg.node().offsetTop + 8) + 'px';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Find node\u2026';
    searchInput.className = 'input input-sm input-bordered w-56 shadow';
    searchInput.value = this._search || '';
    searchInput.addEventListener('input', () => {
      this._search = searchInput.value.trim();
      this.applySearch();
    });
    searchWrap.appendChild(searchInput);
    target.appendChild(searchWrap);
    this._searchInput = searchInput;

    // Set up pan/zoom once so the current view is preserved across redraws
    // (expanding/collapsing must not move or rescale the view).
    const zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        if (this._relContent) this._relContent.attr('transform', event.transform);
        this.updateZoomLabel(event.transform.k);
        this.saveRelState();
      });
    svg.call(zoom).on('dblclick.zoom', null);
    this._relZoom = zoom;

    // Toggle the hovered node's underline as Ctrl/Cmd is pressed or released.
    if (!this._keyHandler) {
      this._keyHandler = (e) => this.updateHoverUnderline(e.ctrlKey || e.metaKey);
      window.addEventListener('keydown', this._keyHandler);
      window.addEventListener('keyup', this._keyHandler);
    }

    target.appendChild(svg.node());
    // Restore a saved pan/zoom if we have one; otherwise fit on first draw.
    const cached = DB_REL_STATE.get(this.database);
    if (cached && cached.transform) {
      const tr = cached.transform;
      svg.call(zoom.transform, d3.zoomIdentity.translate(tr.x, tr.y).scale(tr.k));
      this._fitPending = false;
    } else {
      this._fitPending = true;   // fit only on the first draw
    }
    this.drawGraph();
  }

  // (Re)draws the collapsible hierarchy tree for the current expansion state.
  // A shared table is duplicated under each parent that references it, keeping
  // every branch's links short and easy to follow. Nodes/links are keyed by
  // their path so expand/collapse animates via enter/update/exit transitions.
  drawGraph() {
    const svg = this._relSvg;
    // Persistent layers so d3 can diff between draws and animate the change.
    let content = this._relContent;
    if (!content) {
      content = svg.append('g');
      content.attr('transform', d3.zoomTransform(svg.node()));
      this._relLinkLayer = content.append('g')
        .attr('fill', 'none')
        .attr('stroke', '#94a3b8')
        .attr('stroke-width', 1.5);
      this._relNodeLayer = content.append('g');
      this._relContent = content;
    }

    const dur = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 0 : 400;
    const padX = 8, padY = 4, rowH = 34, colGap = 80;
    const term = (this._search || '').toLowerCase();

    // Build a tree where each rendered instance is unique (shared tables are
    // duplicated once per parent). A cycle guard stops infinite recursion.
    // `key` is the branch path, stable across redraws for smooth transitions.
    const makeNode = (id, depth, ancestors, parentKey) => {
      const key = parentKey ? parentKey + '/' + id : id;
      const n = { id, depth, key, children: [] };
      if (this._expanded.has(id) && !ancestors.has(id)) {
        const anc = new Set(ancestors); anc.add(id);
        for (const c of (this._children.get(id) || [])) {
          n.children.push(makeNode(c, depth + 1, anc, key));
        }
      }
      return n;
    };
    let roots = [...this._roots].filter(r => this._allNodes.has(r));
    // While searching, keep only root branches that contain a matching node.
    if (term) roots = roots.filter(r => this.subtreeMatches(r, term));
    // Group roots that reference the same table so they render next to each other.
    roots = this.orderRoots(roots);
    const built = roots.map(r => makeNode(r, 0, new Set(), ''));

    // Merge roots that reference an identical set of children: draw that shared
    // subtree once and link every such root to the single copy. Roots are
    // grouped by a signature of their (rendered) child subtree.
    const sigOf = (n) => n.id + (n.children.length ? '(' + n.children.map(sigOf).sort().join(',') + ')' : '');
    const groups = [];
    const groupBySig = new Map();
    built.forEach(rn => {
      const sig = rn.children.length ? rn.children.map(sigOf).sort().join(',') : null;
      if (sig && groupBySig.has(sig)) {
        groupBySig.get(sig).roots.push(rn);
      } else {
        const g = { roots: [rn], children: rn.children };
        if (sig) groupBySig.set(sig, g);
        groups.push(g);
      }
    });
    groups.forEach(g => { g.shared = g.roots.length > 1; });

    // Pill geometry + flat node list. Root pills are measured individually; the
    // (possibly shared) child subtree is measured once per group.
    const allNodes = [];
    let maxDepth = 0;
    const setPill = (n) => {
      const bold = n.depth === 0;
      const collapsed = (this._children.get(n.id) || []).length && !this._expanded.has(n.id);
      n.bold = bold;
      n.label = (collapsed ? '\u25B8 ' : '') + n.id;
      n.w = this.measureLabel(n.label, bold) + padX * 2;
      maxDepth = Math.max(maxDepth, n.depth);
      allNodes.push(n);
    };
    const measureTree = (n) => { setPill(n); n.children.forEach(measureTree); };
    groups.forEach(g => {
      g.roots.forEach(setPill);
      g.children.forEach(measureTree);
    });

    // Column x positions derived from the widest pill in each column.
    const colMax = new Array(maxDepth + 1).fill(0);
    allNodes.forEach(n => { colMax[n.depth] = Math.max(colMax[n.depth], n.w); });
    const colX = new Array(maxDepth + 1).fill(0);
    for (let d = 1; d <= maxDepth; d++) colX[d] = colX[d - 1] + colMax[d - 1] + colGap;

    // Tidy-tree y layout: leaves get sequential rows, parents center on kids.
    let yCounter = 0;
    const assign = (n) => {
      n.x = colX[n.depth];
      if (!n.children.length) {
        n.y = yCounter * rowH;
        yCounter++;
      } else {
        n.children.forEach(assign);
        n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
      }
    };
    const shiftY = (n, dy) => { n.y += dy; n.children.forEach(c => shiftY(c, dy)); };
    groups.forEach(g => {
      if (!g.shared) { assign(g.roots[0]); return; }
      // Lay out the shared child subtree, then stack the roots centered on it.
      const before = yCounter;
      g.children.forEach(assign);
      const childRows = yCounter - before;
      const k = g.roots.length;
      if (k > childRows) {
        // Roots need more vertical room than the children: center the children.
        const dy = ((k - childRows) / 2) * rowH;
        g.children.forEach(c => shiftY(c, dy));
        yCounter = before + k;
      }
      const center = (g.children[0].y + g.children[g.children.length - 1].y) / 2;
      g.roots.forEach((r, i) => {
        r.x = colX[0];
        r.y = center + (i - (k - 1) / 2) * rowH;
      });
    });

    // Final layout bounds (from data, not mid-animation geometry) so fitToView
    // can recenter accurately even while transitions are still running.
    if (allNodes.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const halfH = 12;
      allNodes.forEach(n => {
        minX = Math.min(minX, n.x);
        maxX = Math.max(maxX, n.x + n.w);
        minY = Math.min(minY, n.y - halfH);
        maxY = Math.max(maxY, n.y + halfH);
      });
      this._lastBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    } else {
      this._lastBounds = null;
    }

    // Links (curved parent → child), keyed by the endpoints' paths. Shared
    // groups link every root to the single shared child subtree.
    const links = [];
    const treeLinks = (n) => n.children.forEach(c => { links.push({ s: n, t: c, key: n.key + '=>' + c.key }); treeLinks(c); });
    groups.forEach(g => {
      if (g.shared) {
        g.roots.forEach(r => g.children.forEach(c => links.push({ s: r, t: c, key: r.key + '=>' + c.key })));
        g.children.forEach(treeLinks);
      } else {
        treeLinks(g.roots[0]);
      }
    });
    const linkPath = (l) => {
      const x1 = l.s.x + l.s.w, y1 = l.s.y, x2 = l.t.x, y2 = l.t.y;
      const mx = (x1 + x2) / 2;
      return `M${x1},${y1}C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    };

    const linkSel = this._relLinkLayer.selectAll('path').data(links, l => l.key);
    linkSel.exit().transition().duration(dur).style('opacity', 0).remove();
    const linkEnter = linkSel.enter().append('path')
      .attr('marker-end', 'url(#db-rel-arrow-' + this._uid + ')')
      .attr('d', linkPath)
      .style('opacity', 0);
    linkEnter.merge(linkSel).transition().duration(dur)
      .style('opacity', 1)
      .attr('d', linkPath);

    // Renders (or refreshes) a node's pill + label in place.
    const buildPill = (g, n) => {
      g.selectAll('*').remove();
      const text = g.append('text')
        .attr('x', padX)
        .attr('y', 0)
        .attr('dominant-baseline', 'middle')
        .attr('text-anchor', 'start')
        .attr('font-size', 12)
        .attr('font-weight', n.bold ? 700 : 400)
        .attr('fill', '#fff')
        .text(n.label);
      const bb = text.node().getBBox();
      const rect = g.insert('rect', 'text')
        .attr('x', 0)
        .attr('y', bb.y - padY)
        .attr('width', n.w)
        .attr('height', bb.height + padY * 2)
        .attr('rx', 8)
        .attr('ry', 8)
        .attr('fill', this.nodeColor(n.id));
      // Purple stroke marks sub-nodes referenced by more than one root branch.
      if (this._multiRootNodes && this._multiRootNodes.has(n.id)) {
        rect.attr('stroke', '#a855f7').attr('stroke-width', 2.5);
      } else {
        rect.attr('class', 'stroke-base-100').attr('stroke-width', 1.5);
      }
      if (term && n.id.toLowerCase().includes(term)) rect.classed('db-rel-hit', true);
      const kids = (this._children.get(n.id) || []).length;
      g.append('title').text(kids ? n.id + ' \u2014 references ' + kids + ' table' + (kids === 1 ? '' : 's') : n.id);
    };

    // Nodes: rounded-rectangle pills filled with the category color.
    const nodeSel = this._relNodeLayer.selectAll('g.db-rel-node').data(allNodes, n => n.key);
    nodeSel.exit().transition().duration(dur).style('opacity', 0).remove();
    const nodeEnter = nodeSel.enter().append('g')
      .attr('class', 'db-rel-node')
      .attr('transform', n => `translate(${n.x},${n.y})`)
      .style('opacity', 0)
      .style('cursor', 'pointer');
    const merged = nodeEnter.merge(nodeSel);
    merged
      .on('click', (event, n) => {
        // Ctrl/Cmd + click opens the table; plain click toggles its children.
        if (event.ctrlKey || event.metaKey) {
          event.stopPropagation();
          this.navigateToTable(n.id);
          return;
        }
        const kids = this._children.get(n.id) || [];
        if (!kids.length) return;
        if (this._expanded.has(n.id)) this._expanded.delete(n.id);
        else this._expanded.add(n.id);
        this.saveRelState();
        this.drawGraph();
        this.updateExpandBtn();
      })
      .on('mouseenter', (event) => {
        this._hoverNodeEl = event.currentTarget;
        this.updateHoverUnderline(event.ctrlKey || event.metaKey);
      })
      .on('mousemove', (event) => this.updateHoverUnderline(event.ctrlKey || event.metaKey))
      .on('mouseleave', () => { this.updateHoverUnderline(false); this._hoverNodeEl = null; })
      .each((n, i, gs) => buildPill(d3.select(gs[i]), n));
    merged.transition().duration(dur)
      .style('opacity', 1)
      .attr('transform', n => `translate(${n.x},${n.y})`);

    if (this._fitPending) {
      this._fitPending = false;
      requestAnimationFrame(() => this.fitToView());
    }
  }

  // Updates the zoom-percentage readout in the toolbar.
  updateZoomLabel(k) {
    if (this._zoomLabel) this._zoomLabel.textContent = Math.round(k * 100) + '%';
  }

  // Underlines the currently hovered node's label while Ctrl/Cmd is held, to
  // signal that a Ctrl+click will open (navigate to) that table.
  updateHoverUnderline(on) {
    if (!this._hoverNodeEl) return;
    const text = this._hoverNodeEl.querySelector('text');
    if (text) text.style.textDecoration = on ? 'underline' : '';
  }

  // Zooms/pans so the whole tree (pills + labels) is centered and fits.
  fitToView() {
    const g = this._relContent;
    if (!g || !this._relSvg || !this._relZoom) return;
    // Prefer the data-derived bounds (stable during animations); fall back to
    // measured geometry if they aren't available yet.
    const bbox = this._lastBounds || g.node().getBBox();
    if (!bbox.width || !bbox.height) return;
    const pad = 40;
    const w = this._relW, h = this._relH;
    const scale = Math.min(1.5, Math.min(w / (bbox.width + pad * 2), h / (bbox.height + pad * 2)));
    const tx = w / 2 - scale * (bbox.x + bbox.width / 2);
    const ty = h / 2 - scale * (bbox.y + bbox.height / 2);
    this._relSvg.transition().duration(300)
      .call(this._relZoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }

  // Opens a translucent modal showing the table's data and structure by
  // embedding a <table-details> element (reuses its Data/Structure tabs).
  openTableModal(name) {
    const tables = (typeof dbTables !== 'undefined' && dbTables[this.database]) || [];
    const t = tables.find(x => x.name === name);
    const schema = (t && t.schemaName) || 'dbo';

    let dlg = this._tableModal;
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'modal';
      dlg.innerHTML =
        '<div class="modal-box w-11/12 max-w-5xl border border-base-300 bg-base-100/80 backdrop-blur">' +
          '<form method="dialog">' +
            '<button class="btn btn-sm btn-circle btn-ghost absolute right-3 top-3">\u2715</button>' +
          '</form>' +
          '<h3 class="mb-3 text-lg font-bold" data-modal-title></h3>' +
          '<div data-modal-body></div>' +
        '</div>' +
        '<form method="dialog" class="modal-backdrop"><button>close</button></form>';
      document.body.appendChild(dlg);
      // Tear down the embedded component when the modal closes.
      dlg.addEventListener('close', () => {
        const b = dlg.querySelector('[data-modal-body]');
        if (b) b.innerHTML = '';
      });
      this._tableModal = dlg;
    }

    dlg.querySelector('[data-modal-title]').textContent = name;
    const body = dlg.querySelector('[data-modal-body]');
    body.innerHTML = '';
    const el = document.createElement('table-details');
    el.setAttribute('cs', this.cs);
    el.setAttribute('database', this.database);
    el.setAttribute('schema', schema);
    el.setAttribute('table', name);
    el.setAttribute('tabs', 'Data,Structure');
    body.appendChild(el);
    dlg.showModal();
  }

  // Navigates the app to a table by name (double-click on a node).
  navigateToTable(name) {
    try {
      if (typeof selectTable !== 'function') return;
      const tables = (typeof dbTables !== 'undefined' && dbTables[this.database]) || [];
      const t = tables.find(x => x.name === name) || { name: name, schemaName: 'dbo' };
      selectTable(this.database, t);
    } catch (e) { /* navigation unavailable */ }
  }
}

customElements.define('db-details', DbDetails);
