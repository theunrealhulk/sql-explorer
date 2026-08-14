// <table-details> — a 4-tab element (Data, Structure, Relations, SQL) for a
// selected table. Renders in the light DOM so global daisyUI/Tailwind styles apply.
class TableDetails extends HTMLElement {
  static get observedAttributes() {
    return ['cs', 'database', 'schema', 'table', 'tabs'];
  }

  constructor() {
    super();
    this.page = 1;
    this.pageSize = 50;
    this.hiddenColumns = new Set();
    this.dataView = localStorage.getItem('data-view') || 'table';
    this.search = '';
    this.fuzzy = false;
    this.caseSensitive = false;
    this._searchTimer = null;
    this._jsonEditor = null;
    this._jsonCollapsed = new Set();
    this._jsonSearch = '';
    this._lastData = null;
    this._colFilter = '';
    this._colMenuOpen = false;
    this._colFilters = {};
    this._structColFilters = {};
    this._structSortCol = null;
    this._structSortDir = 1;
    this._uid = 'td-' + Math.random().toString(36).slice(2);
  }

  get cs() { return this.getAttribute('cs') || ''; }
  get database() { return this.getAttribute('database') || ''; }
  get schema() { return this.getAttribute('schema') || 'dbo'; }
  get table() { return this.getAttribute('table') || ''; }

  // Which tabs to render. Defaults to all four; a comma-separated `tabs`
  // attribute (e.g. tabs="Data,Structure") restricts and orders them.
  get allowedTabs() {
    const attr = this.getAttribute('tabs');
    const all = ['Data', 'Structure', 'Relations', 'SQL'];
    if (!attr) return all;
    const picked = attr.split(',').map(s => s.trim()).filter(s => all.includes(s));
    return picked.length ? picked : all;
  }

  connectedCallback() {
    // Close the column dropdown when clicking anywhere outside it (native
    // <details> stays open otherwise).
    this._onDocClick = (e) => {
      const dd = this.querySelector('[data-colslot] details.dropdown');
      if (dd && dd.open && !dd.contains(e.target)) {
        dd.open = false;
        this._colMenuOpen = false;
      }
    };
    document.addEventListener('click', this._onDocClick);
    this.renderShell();
    this.loadTableState();
    this.buildDataPanel();
    const allowed = this.allowedTabs;
    if (allowed.includes('Data')) this.loadData();
    if (allowed.includes('Structure')) this.loadStructure();
    if (allowed.includes('Relations')) this.loadRelations();
  }

  disconnectedCallback() {
    if (this._onDocClick) document.removeEventListener('click', this._onDocClick);
    if (this._relKeyHandler) {
      window.removeEventListener('keydown', this._relKeyHandler);
      window.removeEventListener('keyup', this._relKeyHandler);
      this._relKeyHandler = null;
    }
    if (this._jsonEditor) { this._jsonEditor.destroy(); this._jsonEditor = null; }
    if (this._relSim) { this._relSim.stop(); this._relSim = null; }
    if (this._sqlCtrl) { this._sqlCtrl.destroy(); this._sqlCtrl = null; }
    this._sqlTab = false;
    this.closeNodeOverlay();
  }

  attributeChangedCallback() {
    if (!this.isConnected) return;
    this.page = 1;
    this.hiddenColumns = new Set();
    this.search = '';
    this.fuzzy = false;
    this.caseSensitive = false;
    this._colFilter = '';
    this._colMenuOpen = false;
    this._colFilters = {};
    this._structColFilters = {};
    this._structSortCol = null;
    this._structSortDir = 1;
    if (this._sqlCtrl) { this._sqlCtrl.destroy(); this._sqlCtrl = null; }
    this._sqlTab = false;
    this.renderShell();
    this.loadTableState();
    this.buildDataPanel();
    const allowed = this.allowedTabs;
    if (allowed.includes('Data')) this.loadData();
    if (allowed.includes('Structure')) this.loadStructure();
    if (allowed.includes('Relations')) this.loadRelations();
  }

  async api(path, body) {
    const res = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // Persist per-table UI state (hidden columns + per-column filters) so it
  // survives a refresh. Keyed by the table's fully-qualified identity.
  stateKey() {
    return 'sql-explorer-tablestate:' + this.database + '.' + this.schema + '.' + this.table;
  }

  loadTableState() {
    this.hiddenColumns = new Set();
    this._colFilters = {};
    this._sortCol = null;
    this._sortDir = 1;
    this.search = '';
    this.fuzzy = false;
    this.caseSensitive = false;
    this._structColFilters = {};
    this._structSortCol = null;
    this._structSortDir = 1;
    this._jsonCollapsed = new Set();
    this._jsonSearch = '';
    try {
      const raw = localStorage.getItem(this.stateKey());
      if (!raw) return;
      const s = JSON.parse(raw);
      if (Array.isArray(s.hidden)) this.hiddenColumns = new Set(s.hidden);
      if (s.filters && typeof s.filters === 'object') this._colFilters = s.filters;
      if (typeof s.sortCol === 'string') this._sortCol = s.sortCol;
      if (s.sortDir === -1 || s.sortDir === 1) this._sortDir = s.sortDir;
      if (typeof s.search === 'string') this.search = s.search;
      if (typeof s.fuzzy === 'boolean') this.fuzzy = s.fuzzy;
      if (typeof s.caseSensitive === 'boolean') this.caseSensitive = s.caseSensitive;
      if (s.structFilters && typeof s.structFilters === 'object') this._structColFilters = s.structFilters;
      if (typeof s.structSortCol === 'string') this._structSortCol = s.structSortCol;
      if (s.structSortDir === -1 || s.structSortDir === 1) this._structSortDir = s.structSortDir;
      if (Array.isArray(s.jsonCollapsed)) this._jsonCollapsed = new Set(s.jsonCollapsed);
      if (typeof s.jsonSearch === 'string') this._jsonSearch = s.jsonSearch;
    } catch (_) { /* ignore corrupt state */ }
  }

  saveTableState() {
    if (window.saveEnabled && !window.saveEnabled('tableData')) return;
    try {
      localStorage.setItem(this.stateKey(), JSON.stringify({
        hidden: [...this.hiddenColumns],
        filters: this._colFilters,
        sortCol: this._sortCol,
        sortDir: this._sortDir,
        search: this.search,
        fuzzy: this.fuzzy,
        caseSensitive: this.caseSensitive,
        structFilters: this._structColFilters,
        structSortCol: this._structSortCol,
        structSortDir: this._structSortDir,
        jsonCollapsed: [...this._jsonCollapsed],
        jsonSearch: this._jsonSearch,
      }));
    } catch (_) { /* ignore quota/serialisation errors */ }
  }

  renderShell() {
    const panel = 'tab-content bg-base-100 border-base-300 p-4';
    const allowed = this.allowedTabs;
    const saved = localStorage.getItem('table-tab') || 'Data';
    const active = allowed.includes(saved) ? saved : allowed[0];
    const tab = (label, panelName, body) =>
      '<input type="radio" name="' + this._uid + '" role="tab" class="tab" aria-label="' + label + '"' +
        ' data-tab="' + label + '"' + (label === active ? ' checked' : '') + ' />' +
      '<div role="tabpanel" class="' + panel + '" data-panel="' + panelName + '" data-tabpanel="' + label + '">' + (body || '') + '</div>';
    const defs = {
      Data: () => tab('Data', 'data', ''),
      Structure: () => tab('Structure', 'structure', ''),
      Relations: () => tab('Relations', 'relations', ''),
      SQL: () => tab('SQL', 'sql', ''),
    };
    // When only one tab is allowed, render its panel bare (no tab bar) so the
    // component can be embedded inside another tabbed host without nesting.
    if (allowed.length === 1) {
      const only = allowed[0];
      const panelName = { Data: 'data', Structure: 'structure', Relations: 'relations', SQL: 'sql' }[only];
      this.innerHTML =
        '<div role="tabpanel" class="bg-base-100" data-panel="' + panelName + '" data-tabpanel="' + only + '"></div>';
      return;
    }
    this.innerHTML =
      '<div role="tablist" class="tabs tabs-lift">' +
        allowed.map(label => defs[label]()).join('') +
      '</div>';
    // Persist the active tab whenever it changes
    this.querySelectorAll('input[role="tab"]').forEach(input => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        const label = input.getAttribute('aria-label');
        localStorage.setItem('table-tab', label);
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
    return {
      tabs: () => self.allowedTabs,
      activeTab: () => {
        const checked = self.querySelector('input[role="tab"]:checked');
        return checked ? checked.getAttribute('aria-label') : self.allowedTabs[0];
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
    window.SqlScratchTab.mount(target, { cs: this.cs, database: this.database, schema: this.schema, table: this.table })
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

  // Empty-results state for the Data tab. If column filters are active, shows a
  // "Clear filters" button so a filter that matches nothing can still be reset
  // (the table headers, which normally hold the clear icon, aren't rendered).
  emptyData(target) {
    target.innerHTML = '';
    const active = Object.keys(this._colFilters).filter(k => this._colFilters[k]);
    if (!active.length) { this.info(target, 'No rows.'); return; }
    const wrap = document.createElement('div');
    wrap.className = 'flex items-center gap-3';
    const p = document.createElement('p');
    p.className = 'text-base-content/60';
    p.textContent = 'No rows match the active filter.';
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-ghost text-error';
    btn.innerHTML = '<i data-lucide="filter-x" class="size-4"></i> Clear filters';
    btn.addEventListener('click', () => {
      this._colFilters = {};
      this.saveTableState();
      this.page = 1;
      this.loadData();
    });
    wrap.appendChild(p);
    wrap.appendChild(btn);
    target.appendChild(wrap);
    if (window.lucide) window.lucide.createIcons({ root: wrap });
  }

  error(target, text) {
    target.innerHTML = '';
    const div = document.createElement('div');
    div.setAttribute('role', 'alert');
    div.className = 'alert alert-error alert-soft';
    div.textContent = text;
    target.appendChild(div);
  }

  // ---- Data tab ----------------------------------------------------------
  // Builds the persistent search bar (fuzzy + case-sensitive toggles and a
  // large text input) plus a results container. Kept separate from renderData
  // so typing in the search box doesn't lose focus on every reload.
  buildDataPanel() {
    const target = this.panel('data');
    if (!target) return;
    target.innerHTML = '';

    const bar = document.createElement('div');
    bar.className = 'mb-3 flex flex-wrap items-center gap-3';

    // Table / JSON view toggle (shares the line with the search input).
    const viewBar = document.createElement('div');
    viewBar.className = 'join';
    [['table', 'Table'], ['json', 'JSON']].forEach(([mode, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.view = mode;
      btn.className = 'btn btn-sm join-item' + (this.dataView === mode ? ' btn-active btn-primary' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (this.dataView === mode) return;
        this.dataView = mode;
        localStorage.setItem('data-view', mode);
        viewBar.querySelectorAll('button').forEach(b => {
          b.classList.toggle('btn-active', b.dataset.view === mode);
          b.classList.toggle('btn-primary', b.dataset.view === mode);
        });
        if (this._lastData) this.renderData(this.results(), this._lastData);
      });
      viewBar.appendChild(btn);
    });

    const fuzzyLabel = document.createElement('label');
    fuzzyLabel.className = 'label cursor-pointer gap-2';
    const fuzzyBox = document.createElement('input');
    fuzzyBox.type = 'checkbox';
    fuzzyBox.className = 'checkbox checkbox-sm';
    fuzzyBox.checked = this.fuzzy;
    const fuzzyText = document.createElement('span');
    fuzzyText.className = 'label-text whitespace-nowrap';
    fuzzyText.textContent = 'Fuzzy';
    fuzzyLabel.append(fuzzyBox, fuzzyText);

    const caseLabel = document.createElement('label');
    caseLabel.className = 'label cursor-pointer gap-2';
    const caseBox = document.createElement('input');
    caseBox.type = 'checkbox';
    caseBox.className = 'checkbox checkbox-sm';
    caseBox.checked = this.caseSensitive;
    const caseText = document.createElement('span');
    caseText.className = 'label-text whitespace-nowrap';
    caseText.textContent = 'Case sensitive';
    caseLabel.append(caseBox, caseText);

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'input input-bordered input-lg grow';
    input.placeholder = 'Search all columns for a value…';
    input.value = this.search;

    // Slot filled by renderData with the column chooser for the current data.
    const colSlot = document.createElement('div');
    colSlot.setAttribute('data-colslot', '');
    fuzzyBox.addEventListener('change', () => {
      this.fuzzy = fuzzyBox.checked;
      this.saveTableState();
      if (this.search) { this.page = 1; this.loadData(); }
    });
    caseBox.addEventListener('change', () => {
      this.caseSensitive = caseBox.checked;
      this.saveTableState();
      if (this.search) { this.page = 1; this.loadData(); }
    });
    input.addEventListener('input', () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this.search = input.value.trim();
        this.saveTableState();
        this.page = 1;
        this.loadData();
      }, 300);
    });

    bar.append(colSlot, viewBar, fuzzyLabel, caseLabel, input);
    target.appendChild(bar);

    const results = document.createElement('div');
    results.setAttribute('data-results', '');
    target.appendChild(results);
  }

  results() {
    return this.panel('data').querySelector('[data-results]');
  }

  async loadData() {
    const target = this.results();
    if (!target) return;
    this.info(target, 'Loading data…');
    const d = await this.api('data', {
      connectionString: this.cs,
      database: this.database,
      schema: this.schema,
      table: this.table,
      page: this.page,
      pageSize: this.pageSize,
      search: this.search,
      fuzzy: this.fuzzy,
      caseSensitive: this.caseSensitive,
      columnFilters: this._colFilters,
      sortColumn: this._sortCol || '',
      sortDir: this._sortDir === -1 ? 'desc' : 'asc',
    });
    if (!d.ok) { this.error(target, d.error); return; }
    this.applyEmptyDataTab(d.rows && d.rows.length ? true : false);
    this.renderData(target, d);
  }

  // Removes the Data tab entirely if the table has no rows, switching to the
  // next available tab if needed. Skipped while a search or column filter is
  // active so empty filtered results don't hide (and lock away) the tab.
  applyEmptyDataTab(hasRows) {
    if (this.search) return;
    if (Object.values(this._colFilters).some(v => v)) return;
    const input = this.querySelector('input[data-tab="Data"]');
    const panelEl = this.querySelector('[data-tabpanel="Data"]');
    if (hasRows || !input) return;
    const wasActive = input.checked;
    input.remove();
    if (panelEl) panelEl.remove();
    if (wasActive) {
      const next = this.querySelector('input[role="tab"]');
      if (next) {
        next.checked = true;
        next.dispatchEvent(new Event('change'));
      }
    }
  }

  renderData(target, d) {
    if (this._jsonEditor) { this._jsonEditor.destroy(); this._jsonEditor = null; }
    this._lastData = d;
    target.innerHTML = '';

    if (!d.rows.length) {
      this.emptyData(target);
      return;
    }

    // Column chooser: only when there are more than 5 columns. It lives in the
    // toolbar row (data-colslot) next to the Table/JSON toggle.
    const colSlot = this.querySelector('[data-colslot]');
    if (colSlot) {
      colSlot.innerHTML = '';
      if (d.columns.length > 5) colSlot.appendChild(this.columnChooser(this.results(), d));
    }

    const visible = d.columns.filter(c => !this.hiddenColumns.has(c));

    target.appendChild(this.pagination(d, 'top'));
    if (this.dataView === 'json') {
      this.renderJson(target, d, visible);
    } else {
      this.renderTable(target, d, visible);
    }

    target.appendChild(this.pagination(d, 'bottom'));
  }

  // Re-renders only the results body (table/JSON + pagination) using the last
  // fetched data, leaving the toolbar and column chooser DOM untouched. Used on
  // column visibility toggles so the dropdown stays open and keeps its scroll.
  renderResults() {
    const d = this._lastData;
    const target = this.results();
    if (!d || !target) return;
    this.saveTableState();
    if (this._jsonEditor) { this._jsonEditor.destroy(); this._jsonEditor = null; }
    target.innerHTML = '';

    if (!d.rows.length) {
      this.emptyData(target);
      return;
    }

    const visible = d.columns.filter(c => !this.hiddenColumns.has(c));
    target.appendChild(this.pagination(d, 'top'));
    if (this.dataView === 'json') {
      this.renderJson(target, d, visible);
    } else {
      this.renderTable(target, d, visible);
    }
    target.appendChild(this.pagination(d, 'bottom'));
  }

  renderTable(target, d, visible) {
    const wrap = document.createElement('div');
    wrap.className = 'overflow-x-auto';
    if (Object.values(this._colFilters).some(v => v)) wrap.classList.add('filter-active-border');
    const table = document.createElement('table');
    table.className = 'table table-zebra table-sm';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    visible.forEach(c => {
      const th = document.createElement('th');
      this.renderHeaderLabel(th, c);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    d.rows.forEach(row => {
      const tr = document.createElement('tr');
      visible.forEach(c => {
        const td = document.createElement('td');
        td.className = 'max-w-xs break-words whitespace-normal';
        const v = row[c];
        this.highlightInto(td, v === null || v === undefined ? '' : String(v));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    target.appendChild(wrap);
  }

  // Returns true when the given Data-tab column is numeric or date-typed, so
  // its filter accepts comparison operators (=, >, <, >=, <=, !).
  isOperatorColumn(c) {
    const NUM = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric',
      'float', 'real', 'money', 'smallmoney', 'bit']);
    const DATE = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'time']);
    const col = (this._structColumns || []).find(x => x.name === c);
    if (!col) return false;
    const t = String(col.type || '').toLowerCase();
    return NUM.has(t) || DATE.has(t);
  }

  // Column header in label mode: the column name plus a filter toggle icon.
  // The icon is tinted when a filter is active for the column.
  renderHeaderLabel(th, c) {
    th.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'flex items-center justify-between gap-2';
    const label = document.createElement('span');
    label.className = 'inline-flex cursor-pointer select-none items-center gap-1';
    label.title = 'Sort by ' + c;
    const name = document.createElement('span');
    name.textContent = c;
    const arrow = document.createElement('span');
    arrow.className = 'text-base-content/40 text-xs';
    arrow.textContent = this._sortCol === c ? (this._sortDir === 1 ? '\u25b2' : '\u25bc') : '';
    label.append(name, arrow);
    label.addEventListener('click', () => {
      if (this._sortCol === c) this._sortDir = -this._sortDir;
      else { this._sortCol = c; this._sortDir = 1; }
      this.saveTableState();
      this.page = 1;
      this.loadData();
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-xs btn-square';
    const active = !!this._colFilters[c];
    btn.title = active ? ('Filter: ' + this._colFilters[c]) : 'Filter this column';
    btn.innerHTML = '<i data-lucide="filter" class="size-3' + (active ? ' text-primary' : '') + '"></i>';
    btn.addEventListener('click', () => this.renderHeaderInput(th, c));
    const right = document.createElement('div');
    right.className = 'flex items-center gap-1';
    right.appendChild(btn);
    if (active) {
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'btn btn-ghost btn-xs btn-square';
      clr.title = 'Clear filter';
      clr.innerHTML = '<i data-lucide="filter-x" class="size-3 text-error"></i>';
      clr.addEventListener('click', () => { delete this._colFilters[c]; this.saveTableState(); this.page = 1; this.loadData(); });
      right.appendChild(clr);
    }
    box.append(label, right);
    th.appendChild(box);
    if (window.lucide) window.lucide.createIcons({ root: th });
  }

  // Column header in input mode: a text field to type a filter value plus an X
  // to cancel. Enter applies the filter; X (or Escape) exits, clearing any
  // active filter for the column.
  renderHeaderInput(th, c) {
    th.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'flex items-center gap-1';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input input-xs input-bordered w-20';
    const opCol = this.isOperatorColumn(c);
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
        this.saveTableState();
        this.page = 1;
        this.loadData();
      } else if (e.key === 'Escape') {
        this.exitHeaderFilter(th, c);
      }
    });
    x.addEventListener('click', () => this.exitHeaderFilter(th, c));
    box.append(input, x);
    th.appendChild(box);
    if (window.lucide) window.lucide.createIcons({ root: th });
    input.focus();
  }

  // Exits filter-input mode: clears any active filter for the column and
  // re-queries when that changed the result, otherwise restores the label.
  exitHeaderFilter(th, c) {
    const had = !!this._colFilters[c];
    if (had) { delete this._colFilters[c]; this.saveTableState(); this.page = 1; this.loadData(); }
    else this.renderHeaderLabel(th, c);
  }

  // Fills a cell with text, wrapping the parts that match the active search
  // term in <mark>. Builds DOM nodes (never innerHTML) so values stay safe.
  highlightInto(td, text) {
    const term = this.search;
    if (!term || !text) { td.textContent = text; return; }

    const hay = this.caseSensitive ? text : text.toLowerCase();
    const needle = this.caseSensitive ? term : term.toLowerCase();
    const mark = (s) => {
      const m = document.createElement('mark');
      m.className = 'bg-warning text-warning-content rounded-sm px-0.5';
      m.textContent = s;
      return m;
    };

    if (this.fuzzy) {
      // Only highlight if the cell actually contains the term as a subsequence.
      let k = 0;
      for (let i = 0; i < hay.length && k < needle.length; i++) {
        if (hay[i] === needle[k]) k++;
      }
      if (k < needle.length) { td.textContent = text; return; }

      const frag = document.createDocumentFragment();
      let buf = '';
      let ti = 0;
      for (let i = 0; i < text.length; i++) {
        if (ti < needle.length && hay[i] === needle[ti]) {
          if (buf) { frag.appendChild(document.createTextNode(buf)); buf = ''; }
          frag.appendChild(mark(text[i]));
          ti++;
        } else {
          buf += text[i];
        }
      }
      if (buf) frag.appendChild(document.createTextNode(buf));
      td.appendChild(frag);
      return;
    }

    // Non-fuzzy: highlight every contiguous occurrence of the term.
    let pos = hay.indexOf(needle);
    if (pos === -1) { td.textContent = text; return; }
    const frag = document.createDocumentFragment();
    let idx = 0;
    while (pos !== -1) {
      if (pos > idx) frag.appendChild(document.createTextNode(text.slice(idx, pos)));
      frag.appendChild(mark(text.slice(pos, pos + needle.length)));
      idx = pos + needle.length;
      pos = hay.indexOf(needle, idx);
    }
    if (idx < text.length) frag.appendChild(document.createTextNode(text.slice(idx)));
    td.appendChild(frag);
  }

  // Renders the current page rows as a collapsible JSON tree via JSONEditor.
  renderJson(target, d, visible) {
    const container = document.createElement('div');
    container.className = 'border border-base-300 rounded';
    container.style.height = '600px';
    target.appendChild(container);

    const data = d.rows.map(row => {
      const o = {};
      visible.forEach(c => { o[c] = row[c] === undefined ? null : row[c]; });
      return o;
    });

    if (typeof JSONEditor === 'undefined') {
      this.info(target, 'JSON viewer failed to load.');
      return;
    }
    this._jsonEditor = new JSONEditor(container, {
      mode: 'view',
      mainMenuBar: true,
      navigationBar: false,
      search: true,
      // Remember which nodes the user collapses (expand-all is the default).
      onExpand: ({ path, isExpand, recursive }) => {
        const key = JSON.stringify(path);
        if (recursive) {
          for (const k of [...this._jsonCollapsed]) {
            if (this.jsonHasPrefix(JSON.parse(k), path)) this._jsonCollapsed.delete(k);
          }
        }
        if (isExpand) this._jsonCollapsed.delete(key);
        else this._jsonCollapsed.add(key);
        this.saveTableState();
      },
    });
    this._jsonEditor.set(data);
    this.restoreJsonView();
  }

  // True when `path` starts with `prefix` (prefix being a shorter/equal path).
  jsonHasPrefix(path, prefix) {
    if (prefix.length > path.length) return false;
    return prefix.every((v, i) => path[i] === v);
  }

  // Default to expand-all, then re-apply any saved collapsed nodes and the
  // remembered search value.
  restoreJsonView() {
    if (!this._jsonEditor) return;
    this._jsonEditor.expandAll();
    this._jsonCollapsed.forEach(key => {
      try { this._jsonEditor.expand({ path: JSON.parse(key), isExpand: false, recursive: false }); } catch (_) { /* stale path */ }
    });
    const sb = this._jsonEditor.searchBox;
    if (sb && sb.dom && sb.dom.search) {
      if (this._jsonSearch) {
        sb.dom.search.value = this._jsonSearch;
        this._jsonEditor.search(this._jsonSearch);
      }
      sb.dom.search.addEventListener('input', () => {
        this._jsonSearch = sb.dom.search.value;
        this.saveTableState();
      });
    }
  }

  // Inline row of checkboxes to toggle column visibility.
  columnChooser(target, d) {
    return this.columnDropdown(target, d);
  }

  // Multi-check dropdown with a filter box, used when there are many columns.
  columnDropdown(target, d) {
    const details = document.createElement('details');
    details.className = 'dropdown';
    details.open = this._colMenuOpen;
    details.addEventListener('toggle', () => { this._colMenuOpen = details.open; });

    const shown = d.columns.length - this.hiddenColumns.size;
    const summary = document.createElement('summary');
    summary.className = 'btn btn-sm bg-orange-500 text-white border-orange-500 hover:bg-orange-600';
    summary.textContent = 'Columns (' + shown + '/' + d.columns.length + ')';
    details.appendChild(summary);

    const cbs = [];
    const syncSummary = () => {
      const n = d.columns.length - this.hiddenColumns.size;
      summary.textContent = 'Columns (' + n + '/' + d.columns.length + ')';
      allCb.checked = this.hiddenColumns.size === 0;
      allCb.indeterminate = this.hiddenColumns.size > 0 && this.hiddenColumns.size < d.columns.length;
    };

    const content = document.createElement('div');
    content.className = 'dropdown-content z-10 mt-1 w-64 rounded-box border border-base-300 bg-base-100 p-2 shadow';

    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'input input-sm input-bordered w-full mb-2';
    filter.placeholder = 'Filter columns…';
    filter.value = this._colFilter;

    const allLabel = document.createElement('label');
    allLabel.className = 'label cursor-pointer justify-start gap-2 font-semibold';
    const allCb = document.createElement('input');
    allCb.type = 'checkbox';
    allCb.className = 'checkbox checkbox-sm';
    allCb.checked = this.hiddenColumns.size === 0;
    allCb.indeterminate = this.hiddenColumns.size > 0 && this.hiddenColumns.size < d.columns.length;
    allCb.addEventListener('change', () => {
      if (allCb.checked) this.hiddenColumns.clear();
      else d.columns.forEach(c => this.hiddenColumns.add(c));
      cbs.forEach(x => { x.checked = allCb.checked; });
      syncSummary();
      this.renderResults();
    });
    const allSpan = document.createElement('span');
    allSpan.className = 'label-text';
    allSpan.textContent = 'Select all';
    allLabel.append(allCb, allSpan);

    const list = document.createElement('div');
    list.className = 'flex max-h-64 flex-col overflow-y-auto';

    const rows = d.columns.map(c => {
      const label = document.createElement('label');
      label.className = 'label flex w-full cursor-pointer justify-start gap-2';
      label.dataset.col = c.toLowerCase();
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'checkbox checkbox-sm';
      cb.checked = !this.hiddenColumns.has(c);
      cbs.push(cb);
      cb.addEventListener('change', () => {
        if (cb.checked) this.hiddenColumns.delete(c);
        else this.hiddenColumns.add(c);
        syncSummary();
        this.renderResults();
      });
      const span = document.createElement('span');
      span.className = 'label-text';
      span.textContent = c;
      label.append(cb, span);
      list.appendChild(label);
      return label;
    });

    const applyFilter = () => {
      const q = this._colFilter.trim().toLowerCase();
      rows.forEach(r => r.classList.toggle('hidden', !!q && !r.dataset.col.includes(q)));
    };
    filter.addEventListener('input', () => { this._colFilter = filter.value; applyFilter(); });
    applyFilter();

    content.append(filter, allLabel, list);
    details.appendChild(content);
    return details;
  }

  pagination(d, place) {
    const totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
    const bar = document.createElement('div');
    bar.className = (place === 'top' ? 'mb-3' : 'mt-3') + ' flex items-center justify-between gap-2';

    const join = document.createElement('div');
    join.className = 'join';

    const prev = document.createElement('button');
    prev.className = 'btn btn-sm join-item';
    prev.textContent = 'Prev';
    prev.disabled = d.page <= 1;
    prev.addEventListener('click', () => { this.page = d.page - 1; this.loadData(); });

    const next = document.createElement('button');
    next.className = 'btn btn-sm join-item';
    next.textContent = 'Next';
    next.disabled = d.page >= totalPages;
    next.addEventListener('click', () => { this.page = d.page + 1; this.loadData(); });

    join.appendChild(prev);
    join.appendChild(next);

    const info = document.createElement('span');
    info.className = 'text-sm text-base-content/60';
    info.textContent = 'Page ' + d.page + ' of ' + totalPages + ' — ' + d.total.toLocaleString() + ' rows';

    const left = document.createElement('div');
    left.className = 'flex items-center gap-2';
    left.appendChild(join);
    left.appendChild(info);

    // Opposite side of the pagination: an info action showing the current
    // query.
    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-1';
    const infoBtn = document.createElement('button');
    infoBtn.type = 'button';
    infoBtn.className = 'btn btn-sm btn-square btn-ghost';
    infoBtn.title = 'Table info';
    infoBtn.innerHTML = '<i data-lucide="info" class="size-4"></i>';
    infoBtn.addEventListener('click', () => this.showInfo());
    actions.append(infoBtn);

    bar.appendChild(left);
    bar.appendChild(actions);
    if (window.lucide) window.lucide.createIcons({ root: bar });
    return bar;
  }

  // Shows a modal with the SQL query that produced exactly what the user is
  // currently seeing (current page, search, column filters and sort), plus a
  // copy button.
  showInfo() {
    const d = this._lastData;
    if (!d) return;

    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    const box = document.createElement('div');
    box.className = 'modal-box relative max-w-2xl';

    // Reflect exactly what the user sees: the selected (visible) columns
    // instead of SELECT *, keeping the server-built WHERE / ORDER BY / paging.
    const visible = d.columns.filter(c => !this.hiddenColumns.has(c));
    const cols = visible.length
      ? visible.map(c => '[' + String(c).replace(/]/g, ']]') + ']').join(', ')
      : '*';
    let sql = d.sql || 'SELECT * FROM ' + this.database + '.' + this.schema + '.' + this.table;
    sql = sql.replace(/^SELECT \*/, 'SELECT ' + cols);

    // Render the query with the same syntax-highlighted CodeMirror editor used
    // for function/view definitions. The copy button overlays the top-right
    // corner of the code panel, like a markdown code block.
    const editorWrap = document.createElement('div');
    editorWrap.className = 'relative mt-3';
    const editorHost = document.createElement('div');
    editorHost.className = 'max-h-80 overflow-auto rounded-lg border border-base-300 bg-base-200';
    editorWrap.appendChild(editorHost);
    box.appendChild(editorWrap);

    let editor = null;
    if (window.SqlEditor) {
      editor = window.SqlEditor.create(editorHost, sql, this.isDark());
    } else {
      const pre = document.createElement('pre');
      pre.className = 'overflow-auto p-3 text-sm whitespace-pre-wrap break-all';
      const code = document.createElement('code');
      code.textContent = sql;
      pre.appendChild(code);
      editorHost.appendChild(pre);
    }

    // Icon-only copy button overlaid on the top-right corner of the code panel.
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-xs btn-square btn-ghost';
    copy.style.position = 'absolute';
    copy.style.right = '0.5rem';
    copy.style.top = '-1.75rem';
    copy.style.zIndex = '10';
    copy.title = 'Copy query';
    copy.innerHTML = '<i data-lucide="copy" class="size-3.5"></i>';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(sql).then(() => {
        copy.innerHTML = '<i data-lucide="check" class="size-3.5"></i>';
        if (window.lucide) window.lucide.createIcons({ root: copy });
        setTimeout(() => dlg.close(), 300);
      });
    });
    editorWrap.appendChild(copy);

    dlg.appendChild(box);
    const backdrop = document.createElement('form');
    backdrop.method = 'dialog';
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = '<button>close</button>';
    dlg.appendChild(backdrop);

    dlg.addEventListener('close', () => {
      if (editor) { editor.destroy(); editor = null; }
      dlg.remove();
    });
    this.appendChild(dlg);
    if (window.lucide) window.lucide.createIcons({ root: dlg });
    dlg.showModal();
  }

  isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  // ---- Structure tab -----------------------------------------------------
  async loadStructure() {
    const target = this.panel('structure');
    if (!target) return;
    this.buildStructurePanel();
    const results = target.querySelector('[data-struct-results]');
    this.info(results, 'Loading structure…');
    const d = await this.api('columns', {
      connectionString: this.cs,
      database: this.database,
      schema: this.schema,
      table: this.table,
    });
    if (!d.ok) { this.error(results, d.error); return; }
    this._structColumns = d.columns || [];
    this.renderStructure();
  }

  // Builds the results container once; the per-column filter funnels live in
  // the table headers rendered by renderStructure (mirrors the Data tab).
  buildStructurePanel() {
    const target = this.panel('structure');
    if (!target) return;
    target.innerHTML = '';
    const results = document.createElement('div');
    results.setAttribute('data-struct-results', '');
    target.appendChild(results);
  }

  // Structure columns, each with a stable key and a value accessor used for
  // both the per-column filter and sorting.
  structDefs() {
    return [
      { key: 'name', label: 'Column', text: col => col.name || '' },
      { key: 'type', label: 'Type', text: col => col.type || '' },
      { key: 'nullable', label: 'Nullable', text: col => (col.isNullable ? 'YES' : 'NO') },
      { key: 'keys', label: 'Key', text: col => [
        col.isPrimaryKey ? 'PK' : '',
        col.isForeignKey ? 'FK' : '',
        (!col.isPrimaryKey && col.isUnique) ? 'Unique' : '',
      ].filter(Boolean).join(' ') },
    ];
  }

  renderStructure() {
    const target = this.panel('structure');
    if (!target) return;
    const results = target.querySelector('[data-struct-results]');
    if (!results) return;
    results.innerHTML = '';

    const all = this._structColumns || [];
    if (!all.length) { this.info(results, 'No columns.'); return; }

    const defs = this.structDefs();
    // Case-insensitive substring per column, matching the Data tab's filters.
    let rows = all.filter(col => defs.every(d => {
      const f = this._structColFilters[d.key];
      if (!f) return true;
      return String(d.text(col)).toLowerCase().includes(String(f).toLowerCase());
    }));

    if (this._structSortCol) {
      const def = defs.find(d => d.key === this._structSortCol);
      if (def) {
        rows = rows.slice().sort((a, b) =>
          this._structSortDir * String(def.text(a)).localeCompare(String(def.text(b)), undefined, { numeric: true, sensitivity: 'base' }));
      }
    }

    if (!rows.length) { this.emptyStructure(results); return; }

    const wrap = document.createElement('div');
    wrap.className = 'overflow-x-auto';
    const table = document.createElement('table');
    table.className = 'table table-zebra table-sm';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    defs.forEach(def => {
      const th = document.createElement('th');
      this.renderStructHeaderLabel(th, def);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(col => {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = col.name;
      const type = document.createElement('td');
      type.textContent = col.type;
      const nullable = document.createElement('td');
      nullable.textContent = col.isNullable ? 'YES' : 'NO';
      const key = document.createElement('td');
      key.className = 'flex gap-1';
      if (col.isPrimaryKey) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-sm badge-primary';
        badge.textContent = 'PK';
        key.appendChild(badge);
      }
      if (col.isForeignKey) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-sm badge-secondary';
        badge.textContent = 'FK';
        key.appendChild(badge);
      }
      if (!col.isPrimaryKey && col.isUnique) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-sm badge-accent';
        badge.textContent = 'Unique';
        key.appendChild(badge);
      }
      tr.appendChild(name);
      tr.appendChild(type);
      tr.appendChild(nullable);
      tr.appendChild(key);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    results.appendChild(wrap);
  }

  // Empty-results state when active filters match nothing, offering a way to
  // clear them (the headers that hold the filter icons aren't rendered).
  emptyStructure(target) {
    const active = Object.keys(this._structColFilters).filter(k => this._structColFilters[k]);
    if (!active.length) { this.info(target, 'No columns.'); return; }
    const wrap = document.createElement('div');
    wrap.className = 'flex items-center gap-3';
    const p = document.createElement('p');
    p.className = 'text-base-content/60';
    p.textContent = 'No columns match the active filter.';
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-ghost text-error';
    btn.innerHTML = '<i data-lucide="filter-x" class="size-4"></i> Clear filters';
    btn.addEventListener('click', () => {
      this._structColFilters = {};
      this.saveTableState();
      this.renderStructure();
    });
    wrap.append(p, btn);
    target.appendChild(wrap);
    if (window.lucide) window.lucide.createIcons({ root: wrap });
  }

  // Structure header in label mode: sortable name plus a filter toggle icon,
  // tinted when a filter is active. Mirrors the Data tab's renderHeaderLabel.
  renderStructHeaderLabel(th, def) {
    const c = def.key;
    th.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'flex items-center justify-between gap-2';
    const label = document.createElement('span');
    label.className = 'inline-flex cursor-pointer select-none items-center gap-1';
    label.title = 'Sort by ' + def.label;
    const name = document.createElement('span');
    name.textContent = def.label;
    const arrow = document.createElement('span');
    arrow.className = 'text-base-content/40 text-xs';
    arrow.textContent = this._structSortCol === c ? (this._structSortDir === 1 ? '\u25b2' : '\u25bc') : '';
    label.append(name, arrow);
    label.addEventListener('click', () => {
      if (this._structSortCol === c) this._structSortDir = -this._structSortDir;
      else { this._structSortCol = c; this._structSortDir = 1; }
      this.saveTableState();
      this.renderStructure();
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-xs btn-square';
    const active = !!this._structColFilters[c];
    btn.title = active ? ('Filter: ' + this._structColFilters[c]) : 'Filter this column';
    btn.innerHTML = '<i data-lucide="filter" class="size-3' + (active ? ' text-primary' : '') + '"></i>';
    btn.addEventListener('click', () => this.renderStructHeaderInput(th, def));
    const right = document.createElement('div');
    right.className = 'flex items-center gap-1';
    right.appendChild(btn);
    if (active) {
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'btn btn-ghost btn-xs btn-square';
      clr.title = 'Clear filter';
      clr.innerHTML = '<i data-lucide="filter-x" class="size-3 text-error"></i>';
      clr.addEventListener('click', () => { delete this._structColFilters[c]; this.saveTableState(); this.renderStructure(); });
      right.appendChild(clr);
    }
    box.append(label, right);
    th.appendChild(box);
    if (window.lucide) window.lucide.createIcons({ root: th });
  }

  // Structure header in input mode: type a filter value; Enter applies, X or
  // Escape exits. Mirrors the Data tab's renderHeaderInput.
  renderStructHeaderInput(th, def) {
    const c = def.key;
    th.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'flex items-center gap-1';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input input-xs input-bordered w-20';
    input.placeholder = 'Filter…';
    input.value = this._structColFilters[c] || '';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'btn btn-ghost btn-xs btn-square';
    x.title = 'Cancel filter';
    x.innerHTML = '<i data-lucide="x" class="size-3.5"></i>';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        if (val) this._structColFilters[c] = val;
        else delete this._structColFilters[c];
        this.saveTableState();
        this.renderStructure();
      } else if (e.key === 'Escape') {
        this.exitStructHeaderFilter(th, def);
      }
    });
    x.addEventListener('click', () => this.exitStructHeaderFilter(th, def));
    box.append(input, x);
    th.appendChild(box);
    if (window.lucide) window.lucide.createIcons({ root: th });
    input.focus();
  }

  exitStructHeaderFilter(th, def) {
    const c = def.key;
    if (this._structColFilters[c]) { delete this._structColFilters[c]; this.saveTableState(); this.renderStructure(); }
    else this.renderStructHeaderLabel(th, def);
  }

  // ---- Relations tab -----------------------------------------------------
  async loadRelations() {
    const target = this.panel('relations');
    this.info(target, 'Loading relations…');
    const d = await this.api('relations', {
      connectionString: this.cs,
      database: this.database,
      schema: this.schema,
      table: this.table,
    });
    if (!d.ok) { this.error(target, d.error); return; }
    const isolated = !((d.references || []).length) && !((d.referencedBy || []).length);
    this.applyEmptyRelationsTab(isolated);
    this.renderRelations(target, d);
  }

  // Removes the Relations tab entirely when the table is isolated (has no
  // foreign-key relationships), switching to another tab if it was active.
  applyEmptyRelationsTab(isolated) {
    if (!isolated) return;
    const input = this.querySelector('input[data-tab="Relations"]');
    const panelEl = this.querySelector('[data-tabpanel="Relations"]');
    if (!input) return;
    const wasActive = input.checked;
    input.remove();
    if (panelEl) panelEl.remove();
    if (wasActive) {
      const next = this.querySelector('input[role="tab"]');
      if (next) {
        next.checked = true;
        next.dispatchEvent(new Event('change'));
      }
    }
  }

  // Reads the computed background color of a badge so graph nodes match the
  // exact daisyUI badge colors used elsewhere in the app.
  badgeColor(classes) {
    const el = document.createElement('span');
    el.className = classes;
    el.style.position = 'absolute';
    el.style.visibility = 'hidden';
    this.appendChild(el);
    const color = getComputedStyle(el).backgroundColor;
    this.removeChild(el);
    return color || '#888';
  }

  // Injects the blinking-stroke keyframes used to highlight the node whose
  // detail overlay is open — identical to the search-hit effect in the database
  // relations tab (once per document).
  ensureRelSelectStyles() {
    if (document.getElementById('td-rel-select-style')) return;
    const style = document.createElement('style');
    style.id = 'td-rel-select-style';
    style.textContent =
      '@keyframes tdRelBlink{0%,100%{stroke:#ffffff}50%{stroke:#38bdf8}}' +
      '.td-rel-selected{animation:tdRelBlink .8s ease-in-out infinite;stroke-width:3px}';
    document.head.appendChild(style);
  }

  renderRelations(target, rel) {
    if (this._relSim) { this._relSim.stop(); this._relSim = null; }
    this.closeNodeOverlay();
    this.ensureRelSelectStyles();
    target.innerHTML = '';

    const references = rel.references || [];
    const referencedBy = rel.referencedBy || [];
    if (!references.length && !referencedBy.length) {
      this.info(target, 'No foreign-key relationships.');
      return;
    }
    if (typeof d3 === 'undefined') { this.info(target, 'Graph library failed to load.'); return; }

    const colorCenter = this.badgeColor('badge badge-primary');
    const colorRef = this.badgeColor('badge badge-secondary');
    const colorBy = this.badgeColor('bg-green-500');

    // Legend
    const legend = document.createElement('div');
    legend.className = 'mb-2 flex flex-wrap gap-4 text-sm';
    [[colorCenter, 'This table'], [colorRef, 'References (outgoing)'], [colorBy, 'Referenced by (incoming)']]
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
    target.appendChild(legend);

    const hint = document.createElement('p');
    hint.className = 'mb-2 text-xs text-base-content/50';
    hint.textContent = 'Click a node to see its details in an overlay. Ctrl+click a node to switch to that table.';
    target.appendChild(hint);

    const center = { id: this.table, group: 'center', color: colorCenter, r: 14 };
    const nodes = [center];
    const links = [];
    const seen = new Map([[center.id, center]]);
    const addNode = (name, color, group) => {
      let n = seen.get(name);
      if (!n) { n = { id: name, color, r: 10, group }; seen.set(name, n); nodes.push(n); }
      return n;
    };
    references.forEach(name => links.push({ source: center.id, target: addNode(name, colorRef, 'ref').id }));
    referencedBy.forEach(name => links.push({ source: addNode(name, colorBy, 'by').id, target: center.id }));

    const width = target.clientWidth || 800;
    const legendBottom = hint.getBoundingClientRect().bottom;
    const height = Math.max(360, Math.floor(window.innerHeight - legendBottom - 24));

    const svg = d3.create('svg')
      .attr('width', '100%')
      .attr('height', height)
      .attr('viewBox', [0, 0, width, height])
      .attr('class', 'w-full rounded-lg border border-base-300 bg-base-100')
      .attr('fill', 'currentColor');

    // Arrowhead marker
    svg.append('defs').append('marker')
      .attr('id', 'rel-arrow-' + this._uid)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#94a3b8');

    const link = svg.append('g')
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 1.5)
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('marker-end', 'url(#rel-arrow-' + this._uid + ')');

    const node = svg.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .call(d3.drag()
        .on('start', (event, d) => {
          if (!event.active) sim.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y; d.__moved = false;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; d.__moved = true; })
        .on('end', (event, d) => {
          if (!event.active) sim.alphaTarget(0);
          d.fx = null; d.fy = null;
        }));

    this._relNodeSel = node;

    node.style('cursor', 'pointer')
      .on('click', (event, d) => {
        if (event.ctrlKey || event.metaKey) {
          event.stopPropagation();
          this.navigateToTable(d.id);
          return;
        }
        if (d.__moved) return;
        this.showNodeOverlay(d, links, target);
      })
      .on('mouseenter', (event) => {
        this._hoverNodeEl = event.currentTarget;
        this.updateHoverUnderline(event.ctrlKey || event.metaKey);
      })
      .on('mousemove', (event) => this.updateHoverUnderline(event.ctrlKey || event.metaKey))
      .on('mouseleave', () => { this.updateHoverUnderline(false); this._hoverNodeEl = null; });

    // Toggle the hovered node's underline as Ctrl/Cmd is pressed or released.
    if (!this._relKeyHandler) {
      this._relKeyHandler = (e) => this.updateHoverUnderline(e.ctrlKey || e.metaKey);
      window.addEventListener('keydown', this._relKeyHandler);
      window.addEventListener('keyup', this._relKeyHandler);
    }

    node.append('circle')
      .attr('r', d => d.r)
      .attr('fill', d => d.color)
      .attr('class', 'stroke-base-100')
      .attr('stroke-width', 2);

    node.append('text')
      .text(d => d.id)
      .attr('x', 0)
      .attr('y', d => d.r + 14)
      .attr('text-anchor', 'middle')
      .attr('font-size', 12)
      .attr('font-weight', d => (d.group === 'center' ? 700 : 400))
      .attr('fill', 'currentColor');

    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(120))
      .force('charge', d3.forceManyBody().strength(-400))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide().radius(d => d.r + 24))
      .on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        node.attr('transform', d => `translate(${d.x},${d.y})`);
      });
    this._relSim = sim;

    // Anchor the node overlay inside the relations panel.
    target.style.position = 'relative';
    target.appendChild(svg.node());
  }

  // Underlines the currently hovered node's label while Ctrl/Cmd is held, to
  // signal that a Ctrl+click will open (navigate to) that table.
  updateHoverUnderline(on) {
    if (!this._hoverNodeEl) return;
    const text = this._hoverNodeEl.querySelector('text');
    if (text) text.style.textDecoration = on ? 'underline' : '';
  }

  // Navigates the app to another table by name (Ctrl/Cmd+click on a node).
  navigateToTable(name) {
    try {
      if (typeof selectTable !== 'function') return;
      const tables = (typeof dbTables !== 'undefined' && dbTables[this.database]) || [];
      const t = tables.find(x => x.name === name) || { name: name, schemaName: 'dbo' };
      selectTable(this.database, t);
    } catch (e) { /* navigation unavailable */ }
  }

  // Transparent overlay anchored to the right of the relations panel showing
  // the clicked node's attributes and all of its fields.
  showNodeOverlay(d, links, target) {
    this.closeNodeOverlay();

    const roleMap = {
      center: ['This table', 'badge badge-primary'],
      ref: ['Referenced by this table', 'badge badge-secondary'],
      by: ['References this table', 'badge bg-green-500 text-white border-none'],
    };
    const [roleLabel, roleBadge] = roleMap[d.group] || ['Table', 'badge'];

    const outgoing = links
      .filter(l => (l.source.id || l.source) === d.id)
      .map(l => l.target.id || l.target);
    const incoming = links
      .filter(l => (l.target.id || l.target) === d.id)
      .map(l => l.source.id || l.source);

    const overlay = document.createElement('div');
    overlay.className = 'absolute right-0 top-0 z-40 h-full w-80 max-w-[85vw] overflow-y-auto ' +
      'border-l border-base-300 bg-base-100/80 p-4 shadow-xl backdrop-blur-md rounded-r-lg';

    const head = document.createElement('div');
    head.className = 'mb-4 flex items-start justify-between gap-2';
    const title = document.createElement('h3');
    title.className = 'text-lg font-bold break-all';
    title.textContent = d.id;
    const close = document.createElement('button');
    close.className = 'btn btn-sm btn-circle btn-ghost';
    close.textContent = '✕';
    close.addEventListener('click', () => this.closeNodeOverlay());
    head.append(title, close);
    overlay.appendChild(head);

    const attr = (label, valueNode) => {
      const row = document.createElement('div');
      row.className = 'mb-3';
      const l = document.createElement('div');
      l.className = 'text-xs uppercase tracking-wide text-base-content/60 mb-1';
      l.textContent = label;
      row.append(l, valueNode);
      overlay.appendChild(row);
    };

    const roleEl = document.createElement('span');
    roleEl.className = roleBadge;
    roleEl.textContent = roleLabel;
    attr('Role', roleEl);

    const nameEl = document.createElement('div');
    nameEl.className = 'font-medium break-all';
    nameEl.textContent = d.id;
    attr('Table', nameEl);

    const linkList = (names) => {
      const box = document.createElement('div');
      box.className = 'flex flex-wrap gap-1';
      if (!names.length) {
        const none = document.createElement('span');
        none.className = 'text-base-content/50 text-sm';
        none.textContent = 'None';
        box.appendChild(none);
      } else {
        names.forEach(n => {
          const b = document.createElement('span');
          b.className = 'badge badge-sm badge-ghost break-all';
          b.textContent = n;
          box.appendChild(b);
        });
      }
      return box;
    };

    attr('References (' + outgoing.length + ')', linkList(outgoing));
    attr('Referenced by (' + incoming.length + ')', linkList(incoming));

    // Fields of the clicked table (loaded on demand).
    const fieldsBox = document.createElement('div');
    const loading = document.createElement('span');
    loading.className = 'text-base-content/50 text-sm';
    loading.textContent = 'Loading…';
    fieldsBox.appendChild(loading);
    attr('Fields', fieldsBox);

    const hint = document.createElement('p');
    hint.className = 'mt-4 text-xs text-base-content/50';
    hint.textContent = 'Double-click a node to open that table.';
    overlay.appendChild(hint);

    (target || this.panel('relations')).appendChild(overlay);
    this._relOverlay = overlay;

    // Glow the node whose overlay is showing so it stands out in the graph.
    this.setSelectedNodeGlow(d);

    this.loadNodeFields(d.id, fieldsBox, overlay);
  }

  // Fetches and renders all columns of a table into the overlay's Fields box.
  async loadNodeFields(tableName, fieldsBox, overlay) {
    const res = await this.api('columns', {
      connectionString: this.cs,
      database: this.database,
      schema: this.schema,
      table: tableName,
    });
    // Overlay may have been closed/replaced while loading.
    if (this._relOverlay !== overlay) return;
    fieldsBox.innerHTML = '';
    if (!res.ok || !res.columns || !res.columns.length) {
      const none = document.createElement('span');
      none.className = 'text-base-content/50 text-sm';
      none.textContent = res.ok ? 'No columns.' : (res.error || 'Failed to load fields.');
      fieldsBox.appendChild(none);
      return;
    }
    const list = document.createElement('div');
    list.className = 'flex flex-col divide-y divide-base-300 rounded border border-base-300';
    res.columns.forEach(col => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-2 px-2 py-1';
      const left = document.createElement('div');
      left.className = 'flex min-w-0 items-center gap-1';
      const nm = document.createElement('span');
      nm.className = 'truncate text-sm font-medium';
      nm.textContent = col.name;
      left.appendChild(nm);
      if (col.isPrimaryKey) {
        const b = document.createElement('span');
        b.className = 'badge badge-xs badge-primary';
        b.textContent = 'PK';
        left.appendChild(b);
      }
      if (col.isForeignKey) {
        const b = document.createElement('span');
        b.className = 'badge badge-xs badge-secondary';
        b.textContent = 'FK';
        left.appendChild(b);
      }
      if (!col.isPrimaryKey && col.isUnique) {
        const b = document.createElement('span');
        b.className = 'badge badge-xs badge-accent';
        b.textContent = 'U';
        left.appendChild(b);
      }
      const type = document.createElement('span');
      type.className = 'shrink-0 text-xs text-base-content/60';
      type.textContent = col.type + (col.isNullable ? '' : ' ·NN');
      row.append(left, type);
      list.appendChild(row);
    });
    fieldsBox.appendChild(list);
  }

  closeNodeOverlay() {
    if (this._relOverlay) { this._relOverlay.remove(); this._relOverlay = null; }
    this.setSelectedNodeGlow(null);
  }

  // Toggles the blinking-stroke highlight on the graph node matching datum `d`
  // (pass null to clear the highlight from every node).
  setSelectedNodeGlow(d) {
    if (!this._relNodeSel) return;
    this._relNodeSel.select('circle').classed('td-rel-selected', nd => !!d && nd === d);
  }
}

customElements.define('table-details', TableDetails);
