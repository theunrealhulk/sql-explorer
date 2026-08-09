// <view-details> — a 2-tab element (Data, Query) for a selected SQL view.
// The Data tab reuses <table-details> (in single-tab "bare" mode) so it shares
// the exact search / pagination / column-chooser behaviour. The Query tab shows
// the view's T-SQL definition. Renders in the light DOM so global daisyUI /
// Tailwind styles apply.
class ViewDetails extends HTMLElement {
  static get observedAttributes() {
    return ['cs', 'database', 'schema', 'view', 'tabs'];
  }

  constructor() {
    super();
    this._uid = 'vd-' + Math.random().toString(36).slice(2);
  }

  get cs() { return this.getAttribute('cs') || ''; }
  get database() { return this.getAttribute('database') || ''; }
  get schema() { return this.getAttribute('schema') || ''; }
  get view() { return this.getAttribute('view') || ''; }

  // Which tabs to render. Defaults to Data + Query; a comma-separated `tabs`
  // attribute (e.g. tabs="Query") restricts them — used for stored procedures,
  // functions and triggers which only have a definition.
  get allowedTabs() {
    const attr = this.getAttribute('tabs');
    const all = ['Data', 'Query'];
    if (!attr) return all;
    const picked = attr.split(',').map(s => s.trim()).filter(s => all.includes(s));
    return picked.length ? picked : all;
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  async api(path, body) {
    const res = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  render() {
    const allowed = this.allowedTabs;
    const saved = localStorage.getItem('view-tab') || 'Data';
    const active = allowed.includes(saved) ? saved : allowed[0];
    const panel = 'tab-content bg-base-100 border-base-300 p-4';
    const tab = (label, name) =>
      '<input type="radio" name="' + this._uid + '" role="tab" class="tab" aria-label="' + label + '"' +
        (label === active ? ' checked' : '') + ' />' +
      '<div role="tabpanel" class="' + panel + '" data-panel="' + name + '"></div>';
    const defs = { Data: () => tab('Data', 'data'), Query: () => tab('Query', 'query') };
    // A single tab renders bare (no tab bar) since there's nothing to switch to.
    if (allowed.length === 1) {
      const only = allowed[0];
      this.innerHTML = '<div class="bg-base-100 p-4" data-panel="' + only.toLowerCase() + '"></div>';
    } else {
      this.innerHTML =
        '<div role="tablist" class="tabs tabs-lift">' +
          allowed.map(label => defs[label]()).join('') +
        '</div>';
      this.querySelectorAll('input[role="tab"]').forEach(input => {
        input.addEventListener('change', () => {
          if (input.checked) localStorage.setItem('view-tab', input.getAttribute('aria-label'));
        });
      });
    }
    if (allowed.includes('Data')) this.buildData();
    if (allowed.includes('Query')) this.loadQuery();
  }

  // ---- Data tab ----------------------------------------------------------
  buildData() {
    const target = this.querySelector('[data-panel="data"]');
    if (!target) return;
    target.innerHTML = '';
    const el = document.createElement('table-details');
    el.setAttribute('cs', this.cs);
    el.setAttribute('database', this.database);
    el.setAttribute('schema', this.schema);
    el.setAttribute('table', this.view);
    el.setAttribute('tabs', 'Data');
    target.appendChild(el);
  }

  // ---- Query tab ---------------------------------------------------------
  async loadQuery() {
    const target = this.querySelector('[data-panel="query"]');
    if (!target) return;
    const p = document.createElement('p');
    p.className = 'text-base-content/60';
    p.textContent = 'Loading query…';
    target.innerHTML = '';
    target.appendChild(p);
    const d = await this.api('view-definition', {
      connectionString: this.cs,
      database: this.database,
      schema: this.schema,
      view: this.view,
    });
    if (!d.ok) {
      target.innerHTML = '';
      const alert = document.createElement('div');
      alert.setAttribute('role', 'alert');
      alert.className = 'alert alert-error alert-soft';
      alert.textContent = d.error || 'Failed to load view definition.';
      target.appendChild(alert);
      return;
    }
    this.renderQuery(target, d.definition || '');
  }

  renderQuery(target, sql) {
    target.innerHTML = '';
    if (!sql.trim()) {
      const p = document.createElement('p');
      p.className = 'text-base-content/60';
      p.textContent = 'No definition available for this view.';
      target.appendChild(p);
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'mb-2 flex justify-end';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-sm btn-ghost gap-1';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(sql);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      } catch { /* clipboard unavailable */ }
    });
    bar.appendChild(copy);

    const editorHost = document.createElement('div');
    editorHost.className = 'overflow-hidden rounded-lg border border-base-300 bg-base-200';
    target.append(bar, editorHost);

    this.disposeEditor();

    if (window.SqlEditor) {
      const dark = this.isDark();
      this._editor = window.SqlEditor.create(editorHost, sql, dark);
      // Follow the app's light/dark theme while the editor is mounted.
      this._themeObserver = new MutationObserver(() => {
        if (this._editor) window.SqlEditor.setDark(this._editor, this.isDark());
      });
      this._themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
    } else {
      // Fallback: plain preformatted text if the editor bundle failed to load.
      const pre = document.createElement('pre');
      pre.className = 'max-h-[70vh] overflow-auto p-4 text-sm';
      const code = document.createElement('code');
      code.textContent = sql;
      pre.appendChild(code);
      editorHost.appendChild(pre);
    }
  }

  isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  disposeEditor() {
    if (this._themeObserver) { this._themeObserver.disconnect(); this._themeObserver = null; }
    if (this._editor) { this._editor.destroy(); this._editor = null; }
  }

  disconnectedCallback() {
    this.disposeEditor();
  }
}

customElements.define('view-details', ViewDetails);
