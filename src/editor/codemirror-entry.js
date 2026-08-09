// Bundled (esbuild IIFE) CodeMirror 6 setup for the browser. Exposes a small
// helper on `window.SqlEditor` used to render SQL with syntax highlighting,
// light/dark theme support, and (for the editable variant) schema-aware
// autocompletion / IntelliSense. Build with `npm run build:editor`.
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, keymap } from '@codemirror/view';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { sql, MSSQL } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { linter, lintGutter } from '@codemirror/lint';
import { Parser } from 'node-sql-parser';

const lightTheme = [syntaxHighlighting(defaultHighlightStyle)];
const darkTheme = [oneDark];

const baseTheme = EditorView.theme({
  '&': { fontSize: '13px', maxHeight: '70vh', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'auto' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
});

// Live syntax linter: parses the buffer as T-SQL and, on failure, draws a red
// squiggly underline at the offending token.
const sqlParser = new Parser();
const sqlLinter = linter((view) => {
  const code = view.state.doc.toString();
  if (!code.trim()) return [];
  try {
    sqlParser.astify(code, { database: 'transactsql' });
    return [];
  } catch (e) {
    const len = code.length;
    let from = 0;
    let to = len;
    const loc = e && e.location;
    if (loc && loc.start && typeof loc.start.offset === 'number') {
      from = Math.max(0, Math.min(loc.start.offset, len));
      to = loc.end && typeof loc.end.offset === 'number' && loc.end.offset > from
        ? Math.min(loc.end.offset, len)
        : Math.min(len, from + 1);
      // Extend a zero/one-width mark to cover the whole word so it's visible.
      if (to <= from + 1) {
        const m = /\w+/.exec(code.slice(from));
        if (m && m.index === 0) to = Math.min(len, from + m[0].length);
      }
    }
    return [{ from, to, severity: 'error', message: (e && e.message) || 'Syntax error' }];
  }
}, { delay: 400 });

function create(parent, doc, dark) {
  const theme = new Compartment();
  const state = EditorState.create({
    doc: doc || '',
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      sql(),
      baseTheme,
      theme.of(dark ? darkTheme : lightTheme),
    ],
  });
  const view = new EditorView({ state, parent });
  view._themeCompartment = theme;
  return view;
}

function sqlLang(schema) {
  return sql({ dialect: MSSQL, schema: schema || {}, upperCaseKeywords: true });
}

// Editable SQL editor with schema-aware autocompletion, live syntax linting and
// optional run bindings. `callbacks` may contain `onRunAll` (Ctrl/Cmd+Shift+Enter)
// and `onRunCurrent` (Ctrl/Cmd+Enter). `schema` is a map of table name ->
// column names, loaded from the active connection/database.
function createEditable(parent, doc, dark, schema, callbacks) {
  const cb = callbacks || {};
  const theme = new Compartment();
  const lang = new Compartment();
  const runKey = Prec.highest(keymap.of([
    { key: 'Mod-Enter', preventDefault: true, run: () => { if (cb.onRunCurrent) cb.onRunCurrent(); return true; } },
    { key: 'Mod-Shift-Enter', preventDefault: true, run: () => { if (cb.onRunAll) cb.onRunAll(); return true; } },
    indentWithTab,
  ]));
  const state = EditorState.create({
    doc: doc || '',
    extensions: [
      basicSetup,
      runKey,
      EditorView.lineWrapping,
      lang.of(sqlLang(schema)),
      lintGutter(),
      sqlLinter,
      baseTheme,
      theme.of(dark ? darkTheme : lightTheme),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && cb.onChange) cb.onChange(u.state.doc.toString());
      }),
    ],
  });
  const view = new EditorView({ state, parent });
  view._themeCompartment = theme;
  view._langCompartment = lang;
  return view;
}

// Swaps in a new completion schema without recreating the editor.
function setSchema(view, schema) {
  if (!view || !view._langCompartment) return;
  view.dispatch({ effects: view._langCompartment.reconfigure(sqlLang(schema)) });
}

function setDark(view, dark) {
  if (!view || !view._themeCompartment) return;
  view.dispatch({ effects: view._themeCompartment.reconfigure(dark ? darkTheme : lightTheme) });
}

function getValue(view) {
  return view && view.state ? view.state.doc.toString() : '';
}

// Replaces the entire editor contents with `text`.
function setValue(view, text) {
  if (!view || !view.state) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text || '' },
  });
}

// Returns the single SQL statement surrounding the primary cursor. Statements
// are split on top-level semicolons (ignoring those inside quotes, and inside
// line/block comments). Falls back to the whole document when there is no ';'.
// When the user has an active (non-empty) selection, the selected text is
// returned as-is so that multiple highlighted statements run together.
function getStatementAtCursor(view) {
  if (!view || !view.state) return '';
  const sel = view.state.selection.main;
  if (!sel.empty) {
    return view.state.sliceDoc(sel.from, sel.to).trim();
  }
  const doc = view.state.doc.toString();
  const pos = sel.head;
  const boundaries = [];
  let inSingle = false, inDouble = false, inBracket = false;
  let inLine = false, inBlock = false;
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
    if (c === ';') boundaries.push(i);
  }
  let start = 0;
  let end = doc.length;
  for (const b of boundaries) {
    if (b < pos) start = b + 1;
    else { end = b; break; }
  }
  return doc.slice(start, end).trim();
}

window.SqlEditor = { create, createEditable, setSchema, setDark, getValue, setValue, getStatementAtCursor };
