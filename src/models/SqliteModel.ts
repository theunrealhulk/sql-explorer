import Database from 'better-sqlite3';
import {
  TableInfo,
  ColumnInfo,
  TableData,
  ObjectCategories,
  DatabaseStat,
} from './SqlServerModel';

// Extracts the SQLite file path from a connection string. Accepts either a
// bare path or a "Data Source=...;" / "Filename=..." style string.
export function parseSqlitePath(connectionString: string): string {
  const cs = String(connectionString || '').trim();
  const m = cs.match(/(?:Data\s*Source|Filename|DataSource)\s*=\s*([^;]+)/i);
  const path = (m ? m[1] : cs).trim();
  return path.replace(/^['"]|['"]$/g, '');
}

// Returns true when the connection string refers to a SQLite database.
export function isSqliteConnectionString(connectionString: string): boolean {
  const cs = String(connectionString || '').trim();
  if (/sqlite/i.test(cs)) return true;
  if (/Filename\s*=/i.test(cs)) return true;
  // A "Data Source=" that points at a .db/.sqlite file (and not a host:port).
  const m = cs.match(/(?:Data\s*Source|DataSource)\s*=\s*([^;]+)/i);
  const val = (m ? m[1] : cs).trim();
  return /\.(db|sqlite|sqlite3)\b/i.test(val);
}

function openDb(connectionString: string): Database.Database {
  const path = parseSqlitePath(connectionString);
  return new Database(path, { fileMustExist: true });
}

// Quotes a SQLite identifier safely (doubles embedded quotes).
function qid(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

interface RawColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface RawForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
}

interface RawIndex {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

export class SqliteModel {
  // "Databases" for SQLite: a single file behaves as one logical database.
  static async listDatabases(connectionString: string): Promise<string[]> {
    const db = openDb(connectionString);
    try {
      return ['main'];
    } finally {
      db.close();
    }
  }

  static async listDatabaseStats(connectionString: string): Promise<DatabaseStat[]> {
    const db = openDb(connectionString);
    try {
      const tables = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
          )
          .get() as { n: number }
      ).n;
      const views = (
        db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'view'`).get() as {
          n: number;
        }
      ).n;
      const relations = this.countRelations(db);
      return [{ name: 'main', tables, views, relations }];
    } finally {
      db.close();
    }
  }

  private static countRelations(db: Database.Database): number {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    let total = 0;
    for (const t of tables) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${qid(t.name)})`).all() as RawForeignKey[];
      const ids = new Set(fks.map((f) => f.id));
      total += ids.size;
    }
    return total;
  }

  private static tableInfo(db: Database.Database, name: string, isView: boolean): TableInfo {
    const cols = db.prepare(`PRAGMA table_info(${qid(name)})`).all() as RawColumn[];
    const fks = isView
      ? []
      : (db.prepare(`PRAGMA foreign_key_list(${qid(name)})`).all() as RawForeignKey[]);
    const fkGroups = new Set(fks.map((f) => f.id));
    const referencesTablesSet = new Set(fks.map((f) => f.table));

    let rowCount = 0;
    try {
      rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${qid(name)}`).get() as { n: number }).n;
    } catch {
      rowCount = 0;
    }

    // Tables that reference this one (incoming FKs).
    const referencedBySet = new Set<string>();
    if (!isView) {
      const others = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as { name: string }[];
      for (const o of others) {
        if (o.name === name) continue;
        const ofks = db
          .prepare(`PRAGMA foreign_key_list(${qid(o.name)})`)
          .all() as RawForeignKey[];
        if (ofks.some((f) => f.table === name)) referencedBySet.add(o.name);
      }
    }

    const referencedBy = [...referencedBySet];
    const referencesTables = [...referencesTablesSet];
    return {
      name,
      schemaName: 'main',
      fieldCount: cols.length,
      fkCount: fkGroups.size,
      rowCount,
      referencedByCount: referencedBy.length,
      referencedBy: referencedBy.join(','),
      referencesCount: referencesTables.length,
      referencesTables: referencesTables.join(','),
    };
  }

  static async listObjects(
    connectionString: string,
    _database: string
  ): Promise<ObjectCategories> {
    const db = openDb(connectionString);
    try {
      const tableRows = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all() as { name: string }[];
      const viewRows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`)
        .all() as { name: string }[];
      const triggerRows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
        .all() as { name: string }[];

      const tables = tableRows.map((t) => this.tableInfo(db, t.name, false));
      const views = viewRows.map((v) => this.tableInfo(db, v.name, true));

      return {
        Tables: tables,
        Views: views,
        'Stored Procedures': [],
        Functions: [],
        Triggers: triggerRows.map((t) => ({ name: t.name })),
      };
    } finally {
      db.close();
    }
  }

  static async listTables(
    connectionString: string,
    _database: string,
    sort: string,
    dir: string,
    page: number,
    pageSize: number,
    filter: string,
    columnFilters: Record<string, string> = {},
    search = ''
  ): Promise<{ tables: TableInfo[]; total: number; page: number; pageSize: number }> {
    const db = openDb(connectionString);
    try {
      const tableRows = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all() as { name: string }[];
      let all = tableRows.map((t) => this.tableInfo(db, t.name, false));

      // "Find tables by column name" search: keep tables with a matching column.
      const searchTerm = (search || '').trim().toLowerCase();
      if (searchTerm) {
        const matchedList: TableInfo[] = [];
        for (const t of all) {
          const cols = db.prepare(`PRAGMA table_info(${qid(t.name)})`).all() as RawColumn[];
          const matched = cols
            .map((c) => c.name)
            .filter((n) => n.toLowerCase().includes(searchTerm));
          if (matched.length) matchedList.push({ ...t, matchedColumns: matched.join(', ') });
        }
        all = matchedList;
      }

      // Per-column filters + legacy name filter.
      const cf: Record<string, string> = { ...(columnFilters || {}) };
      const legacyName = (filter || '').trim();
      if (legacyName && !cf.name) cf.name = legacyName;

      const numericMatch = (value: number, raw: string): boolean => {
        const s = String(raw || '').trim();
        if (!s) return true;
        const range = s.match(/^\[\s*([^,\]]*?)\s*,\s*([^,\]]*?)\s*\]$/);
        if (range) {
          const a = Number(range[1]);
          const b = Number(range[2]);
          return value >= a && value <= b;
        }
        const list = s.match(/^\(\s*(.*?)\s*\)$/);
        if (list) {
          const nums = list[1]
            .split(',')
            .map((x) => Number(x.trim()))
            .filter((n) => !Number.isNaN(n));
          return nums.includes(value);
        }
        const m = s.match(/^\s*(<=|>=|!=|<>|=|<|>|!)\s*(.*)$/);
        let op = '=';
        let num = s;
        if (m) {
          op = m[1] === '!' || m[1] === '!=' ? '<>' : m[1];
          num = m[2];
        }
        const n = Number(String(num).trim());
        if (Number.isNaN(n)) return String(value).includes(String(num).trim());
        switch (op) {
          case '>':
            return value > n;
          case '<':
            return value < n;
          case '>=':
            return value >= n;
          case '<=':
            return value <= n;
          case '<>':
            return value !== n;
          default:
            return value === n;
        }
      };

      for (const [key, raw] of Object.entries(cf)) {
        const val = String(raw == null ? '' : raw).trim();
        if (!val) continue;
        if (key === 'name') {
          const needle = val.toLowerCase();
          all = all.filter((t) => t.name.toLowerCase().includes(needle));
          continue;
        }
        const numericKeys: (keyof TableInfo)[] = [
          'fieldCount',
          'rowCount',
          'fkCount',
          'referencedByCount',
          'referencesCount',
        ];
        const numKey = key as keyof TableInfo;
        if (numericKeys.includes(numKey)) {
          all = all.filter((t) => numericMatch(Number(t[numKey] as number), val));
        }
      }

      const total = all.length;

      // Sorting.
      const sortKey = (
        {
          name: 'name',
          fieldCount: 'fieldCount',
          rowCount: 'rowCount',
          fkCount: 'fkCount',
          referencedByCount: 'referencedByCount',
        } as Record<string, keyof TableInfo>
      )[sort] || 'name';
      const orderDir = String(dir).toUpperCase() === 'DESC' ? -1 : 1;
      all.sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * orderDir;
        return String(av).localeCompare(String(bv)) * orderDir;
      });

      const safePage = Math.max(1, Math.floor(page) || 1);
      const safeSize = Math.min(500, Math.max(1, Math.floor(pageSize) || 25));
      const offset = (safePage - 1) * safeSize;
      const tables = all.slice(offset, offset + safeSize);

      return { tables, total, page: safePage, pageSize: safeSize };
    } finally {
      db.close();
    }
  }

  static async listColumns(
    connectionString: string,
    _database: string,
    _schema: string,
    table: string
  ): Promise<ColumnInfo[]> {
    const db = openDb(connectionString);
    try {
      const cols = db.prepare(`PRAGMA table_info(${qid(table)})`).all() as RawColumn[];
      const fks = db.prepare(`PRAGMA foreign_key_list(${qid(table)})`).all() as RawForeignKey[];
      const fkCols = new Set(fks.map((f) => f.from));
      const indexes = db.prepare(`PRAGMA index_list(${qid(table)})`).all() as RawIndex[];
      const uniqueCols = new Set<string>();
      for (const idx of indexes) {
        if (idx.unique) {
          const info = db.prepare(`PRAGMA index_info(${qid(idx.name)})`).all() as {
            name: string;
          }[];
          info.forEach((i) => uniqueCols.add(i.name));
        }
      }
      return cols.map((c) => ({
        name: c.name,
        type: c.type || '',
        maxLength: 0,
        isNullable: c.notnull === 0,
        isPrimaryKey: c.pk > 0,
        isForeignKey: fkCols.has(c.name),
        isUnique: uniqueCols.has(c.name) || c.pk > 0,
      }));
    } finally {
      db.close();
    }
  }

  static async getRelations(
    connectionString: string,
    _database: string,
    _schema: string,
    table: string
  ): Promise<{ references: string[]; referencedBy: string[] }> {
    const db = openDb(connectionString);
    try {
      const fks = db.prepare(`PRAGMA foreign_key_list(${qid(table)})`).all() as RawForeignKey[];
      const references = [...new Set(fks.map((f) => f.table))];
      const others = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as { name: string }[];
      const referencedBy: string[] = [];
      for (const o of others) {
        if (o.name === table) continue;
        const ofks = db.prepare(`PRAGMA foreign_key_list(${qid(o.name)})`).all() as RawForeignKey[];
        if (ofks.some((f) => f.table === table)) referencedBy.push(o.name);
      }
      return { references, referencedBy };
    } finally {
      db.close();
    }
  }

  static async getForeignKeyOptions(
    connectionString: string,
    _database: string,
    _schema: string,
    table: string
  ): Promise<{ column: string; refTable: string; refColumn: string; values: unknown[] }[]> {
    const db = openDb(connectionString);
    try {
      const fks = db.prepare(`PRAGMA foreign_key_list(${qid(table)})`).all() as RawForeignKey[];
      const out: { column: string; refTable: string; refColumn: string; values: unknown[] }[] = [];
      for (const fk of fks) {
        let refColumn = fk.to;
        if (!refColumn) {
          const pk = (db.prepare(`PRAGMA table_info(${qid(fk.table)})`).all() as RawColumn[]).find(
            (c) => c.pk > 0
          );
          refColumn = pk ? pk.name : '';
        }
        let values: unknown[] = [];
        if (refColumn) {
          try {
            const rows = db
              .prepare(
                `SELECT DISTINCT ${qid(refColumn)} AS val FROM ${qid(fk.table)} WHERE ${qid(
                  refColumn
                )} IS NOT NULL ORDER BY ${qid(refColumn)} LIMIT 1000`
              )
              .all() as { val: unknown }[];
            values = rows.map((r) => r.val);
          } catch {
            values = [];
          }
        }
        out.push({ column: fk.from, refTable: fk.table, refColumn, values });
      }
      return out;
    } finally {
      db.close();
    }
  }

  static async getDbRelations(
    connectionString: string,
    _database: string
  ): Promise<{ edges: { from: string; to: string }[]; isolatedCount: number; isolatedTables: string[] }> {
    const db = openDb(connectionString);
    try {
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as { name: string }[];
      const edges: { from: string; to: string }[] = [];
      const connected = new Set<string>();
      for (const t of tables) {
        const fks = db.prepare(`PRAGMA foreign_key_list(${qid(t.name)})`).all() as RawForeignKey[];
        for (const fk of fks) {
          if (fk.table && fk.table !== t.name) {
            edges.push({ from: t.name, to: fk.table });
            connected.add(t.name);
            connected.add(fk.table);
          }
        }
      }
      const uniqueEdges = Array.from(
        new Map(edges.map((e) => [e.from + '\u0000' + e.to, e])).values()
      );
      const isolatedTables = tables.map((t) => t.name).filter((n) => !connected.has(n));
      return {
        edges: uniqueEdges,
        isolatedCount: isolatedTables.length,
        isolatedTables,
      };
    } finally {
      db.close();
    }
  }

  static async runQuery(
    connectionString: string,
    _database: string,
    sqlText: string
  ): Promise<{
    resultSets: { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }[];
    rowsAffected: number[];
  }> {
    const MAX_ROWS = 1000;
    const db = openDb(connectionString);
    try {
      const statements = sqlText
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const resultSets: {
        columns: string[];
        rows: Record<string, unknown>[];
        truncated: boolean;
      }[] = [];
      const rowsAffected: number[] = [];
      for (const stmt of statements) {
        const prepared = db.prepare(stmt);
        if (prepared.reader) {
          const rowsAll = prepared.all() as Record<string, unknown>[];
          const columns = rowsAll[0]
            ? Object.keys(rowsAll[0])
            : (prepared.columns() as { name: string }[]).map((c) => c.name);
          resultSets.push({
            columns,
            rows: rowsAll.slice(0, MAX_ROWS),
            truncated: rowsAll.length > MAX_ROWS,
          });
        } else {
          const info = prepared.run();
          rowsAffected.push(info.changes);
        }
      }
      return { resultSets, rowsAffected };
    } finally {
      db.close();
    }
  }

  static async getSchema(
    connectionString: string,
    _database: string
  ): Promise<Record<string, string[]>> {
    const db = openDb(connectionString);
    try {
      const objs = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all() as { name: string }[];
      const schema: Record<string, string[]> = {};
      for (const o of objs) {
        const cols = db.prepare(`PRAGMA table_info(${qid(o.name)})`).all() as RawColumn[];
        const names = cols.map((c) => c.name);
        schema[o.name] = names;
        schema[`main.${o.name}`] = names;
      }
      return schema;
    } finally {
      db.close();
    }
  }

  static async getViewDefinition(
    connectionString: string,
    _database: string,
    _schema: string,
    view: string
  ): Promise<string> {
    const db = openDb(connectionString);
    try {
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE name = ? LIMIT 1`)
        .get(view) as { sql: string | null } | undefined;
      return (row && row.sql) || '';
    } finally {
      db.close();
    }
  }

  static async getTableData(
    connectionString: string,
    _database: string,
    _schema: string,
    table: string,
    page: number,
    pageSize: number,
    search = '',
    fuzzy = false,
    caseSensitive = false,
    columnFilters: Record<string, string> = {},
    sortColumn = '',
    sortDir = ''
  ): Promise<TableData> {
    const db = openDb(connectionString);
    try {
      const full = qid(table);
      const p = Math.max(1, Math.floor(page) || 1);
      const ps = Math.min(200, Math.max(1, Math.floor(pageSize) || 50));
      const offset = (p - 1) * ps;

      const realCols = (db.prepare(`PRAGMA table_info(${qid(table)})`).all() as RawColumn[]).map(
        (c) => c.name
      );
      const lowerReal = new Set(realCols.map((c) => c.toLowerCase()));

      const escLike = (s: string): string => s.replace(/[%_]/g, (m) => '\\' + m);
      const params: unknown[] = [];
      const clauses: string[] = [];

      const term = (search || '').trim();
      if (term && realCols.length) {
        const pattern = fuzzy
          ? '%' + [...term].map(escLike).join('%') + '%'
          : '%' + escLike(term) + '%';
        // SQLite LIKE is case-insensitive for ASCII by default; use GLOB or a
        // case fold for case sensitivity.
        const conds = realCols.map((c) => {
          if (caseSensitive) {
            params.push(pattern);
            return `CAST(${qid(c)} AS TEXT) LIKE ? ESCAPE '\\'`;
          }
          params.push(pattern);
          return `LOWER(CAST(${qid(c)} AS TEXT)) LIKE LOWER(?) ESCAPE '\\'`;
        });
        clauses.push('(' + conds.join(' OR ') + ')');
      }

      const filterEntries = Object.entries(columnFilters || {}).filter(
        ([, v]) => v != null && String(v).trim() !== ''
      );
      for (const [col, val] of filterEntries) {
        if (!lowerReal.has(String(col).toLowerCase())) continue;
        const raw = String(val).trim();
        const range = raw.match(/^\[\s*([^,\]]*?)\s*,\s*([^,\]]*?)\s*\]$/);
        const list = raw.match(/^\(\s*(.*?)\s*\)$/);
        const opMatch = raw.match(/^\s*(<=|>=|!=|<>|=|<|>|!)\s*(.*)$/);
        if (range && !Number.isNaN(Number(range[1])) && !Number.isNaN(Number(range[2]))) {
          clauses.push(`${qid(col)} BETWEEN ? AND ?`);
          params.push(Number(range[1]), Number(range[2]));
        } else if (list) {
          const nums = list[1]
            .split(',')
            .map((x) => x.trim())
            .filter((x) => x !== '');
          if (nums.length) {
            clauses.push(`${qid(col)} IN (${nums.map(() => '?').join(', ')})`);
            nums.forEach((n) => params.push(Number.isNaN(Number(n)) ? n : Number(n)));
          }
        } else if (opMatch && !Number.isNaN(Number(opMatch[2].trim())) && opMatch[2].trim() !== '') {
          let op = opMatch[1];
          if (op === '!' || op === '!=') op = '<>';
          clauses.push(`${qid(col)} ${op} ?`);
          params.push(Number(opMatch[2].trim()));
        } else {
          clauses.push(`LOWER(CAST(${qid(col)} AS TEXT)) LIKE LOWER(?) ESCAPE '\\'`);
          params.push('%' + escLike(raw) + '%');
        }
      }

      const whereClause = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

      let orderBy = '';
      const sortCol = (sortColumn || '').trim();
      if (sortCol && realCols.some((c) => c.toLowerCase() === sortCol.toLowerCase())) {
        const realName = realCols.find((c) => c.toLowerCase() === sortCol.toLowerCase()) as string;
        const dir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        orderBy = `ORDER BY ${qid(realName)} ${dir}`;
      }

      const total = (
        db
          .prepare(`SELECT COUNT(*) AS total FROM ${full} ${whereClause}`)
          .get(...params) as { total: number }
      ).total;

      const dataRows = db
        .prepare(`SELECT * FROM ${full} ${whereClause} ${orderBy} LIMIT ? OFFSET ?`)
        .all(...params, ps, offset) as Record<string, unknown>[];

      const columns = dataRows[0]
        ? Object.keys(dataRows[0])
        : realCols.slice();

      // Display-only SQL with literals inlined.
      let sqlText = `SELECT * FROM ${full}`;
      if (whereClause) sqlText += '\n' + whereClause;
      if (orderBy) sqlText += '\n' + orderBy;
      sqlText += `\nLIMIT ${ps} OFFSET ${offset}`;

      return { columns, rows: dataRows, total, page: p, pageSize: ps, sql: sqlText };
    } finally {
      db.close();
    }
  }
}
