import { getPool } from '../config/db';

// Quotes a SQL Server identifier safely (escapes closing brackets).
function qid(name: string): string {
  return '[' + String(name).replace(/]/g, ']]') + ']';
}

// SQL Server type names that should be filtered with comparison operators
// (=, >, <, >=, <=, !) rather than substring LIKE.
const NUMERIC_TYPES = new Set([
  'int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric',
  'float', 'real', 'money', 'smallmoney', 'bit',
]);
const DATE_TYPES = new Set([
  'date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'time',
]);

function isNumericType(type: string): boolean {
  return NUMERIC_TYPES.has(String(type || '').toLowerCase());
}
function isDateType(type: string): boolean {
  return DATE_TYPES.has(String(type || '').toLowerCase());
}

// Parses a leading comparison operator from a filter value. Recognises
// <=, >=, !=, <>, !, =, <, >. When none is present the operator defaults to
// '=' (equality). Returns the operator plus the remaining value text.
function parseFilterOperator(raw: string): { op: string; value: string } {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^\s*(<=|>=|!=|<>|=|<|>|!)\s*(.*)$/);
  if (m) {
    let op = m[1];
    if (op === '!' || op === '!=') op = '<>';
    return { op, value: m[2].trim() };
  }
  return { op: '=', value: s };
}

// Builds a SQL condition for a numeric/date column filter. Supports:
//   [min,max]       -> BETWEEN min AND max (inclusive range)
//   (v1,v2,v3)      -> IN (v1, v2, v3)
//   <op>value       -> comparison (=, >, <, >=, <=, !) with '=' as default
// `colExpr` is the comparable column expression; `makeParam` wraps a parameter
// name into a comparable expression; `pushInput` registers a bound value.
function buildTypedFilterClause(
  colExpr: string,
  raw: string,
  paramBase: string,
  makeParam: (name: string) => string,
  pushInput: (name: string, value: string) => void
): string | null {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;

  const range = s.match(/^\[\s*([^,\]]*?)\s*,\s*([^,\]]*?)\s*\]$/);
  if (range) {
    const p1 = paramBase + 'a';
    const p2 = paramBase + 'b';
    pushInput(p1, range[1].trim());
    pushInput(p2, range[2].trim());
    return `${colExpr} BETWEEN ${makeParam(p1)} AND ${makeParam(p2)}`;
  }

  const list = s.match(/^\(\s*(.*?)\s*\)$/);
  if (list) {
    const items = list[1].split(',').map(x => x.trim()).filter(x => x !== '');
    if (items.length) {
      const parts = items.map((item, i) => {
        const p = paramBase + 'i' + i;
        pushInput(p, item);
        return makeParam(p);
      });
      return `${colExpr} IN (${parts.join(', ')})`;
    }
  }

  const { op, value } = parseFilterOperator(s);
  pushInput(paramBase, value);
  return `${colExpr} ${op} ${makeParam(paramBase)}`;
}

export interface TableInfo {
  name: string;
  fieldCount: number;
  fkCount: number;
  rowCount: number;
  referencedByCount: number;
  referencedBy: string;
  referencesCount: number;
  referencesTables: string;
  schemaName?: string;
  matchedColumns?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  maxLength: number;
  isNullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isUnique: boolean;
}

export interface TableData {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  sql?: string;
}

export interface NamedObject {
  name: string;
}

export interface ObjectCategories {
  Tables: TableInfo[];
  Views: TableInfo[];
  'Stored Procedures': NamedObject[];
  Functions: NamedObject[];
  Triggers: NamedObject[];
}

export interface DatabaseStat {
  name: string;
  tables: number;
  views: number;
  relations: number;
}

export class SqlServerModel {
  // Test connection + list databases
  static async listDatabases(connectionString: string): Promise<string[]> {
    const pool = await getPool(connectionString);
    try {
      const result = await pool.request().query<{ name: string }>(
        'SELECT name FROM sys.databases WHERE state = 0 ORDER BY name'
      );
      return result.recordset.map((r) => r.name);
    } finally {
      await pool.close();
    }
  }

  // Per-database object counts (tables, views, foreign-key relations) in one
  // round-trip. Database names come from sys.databases (not user input) and are
  // bracket/quote-escaped, so the generated UNION query is injection-safe.
  static async listDatabaseStats(connectionString: string): Promise<DatabaseStat[]> {
    const pool = await getPool(connectionString);
    try {
      const dbs = (
        await pool.request().query<{ name: string }>(
          'SELECT name FROM sys.databases WHERE state = 0 ORDER BY name'
        )
      ).recordset.map((r) => r.name);
      if (!dbs.length) return [];
      const selects = dbs.map((db) => {
        const lit = "'" + db.replace(/'/g, "''") + "'";
        const q = qid(db);
        return `SELECT ${lit} AS name,
          (SELECT COUNT(*) FROM ${q}.sys.tables) AS tables,
          (SELECT COUNT(*) FROM ${q}.sys.views) AS views,
          (SELECT COUNT(*) FROM ${q}.sys.foreign_keys) AS relations`;
      });
      const result = await pool
        .request()
        .query<DatabaseStat>(selects.join(' UNION ALL '));
      return result.recordset;
    } finally {
      await pool.close();
    }
  }

  // List object categories for one database
  static async listObjects(connectionString: string, database: string): Promise<ObjectCategories> {
    const pool = await getPool(connectionString);
    try {
      const r = pool.request();
      const names = async (query: string): Promise<string[]> =>
        (await r.query<{ name: string }>(query)).recordset.map((x) => x.name);

      // Tables: name + schema + column count + foreign key count + row count
      const tables = (
        await r.query<TableInfo>(`
        SELECT o.name AS name,
                s.name AS schemaName,
                COUNT(DISTINCT c.column_id)  AS fieldCount,
                COUNT(DISTINCT fk.object_id) AS fkCount,
                ISNULL(ps.[rowCount], 0)     AS [rowCount],
                (SELECT COUNT(DISTINCT rfk.parent_object_id)
                   FROM [${database}].sys.foreign_keys rfk
                   WHERE rfk.referenced_object_id = o.object_id) AS referencedByCount,
                (SELECT STRING_AGG(rt.name, ',')
                   FROM (
                     SELECT DISTINCT pt.name
                     FROM [${database}].sys.foreign_keys rfk2
                     JOIN [${database}].sys.tables pt ON pt.object_id = rfk2.parent_object_id
                     WHERE rfk2.referenced_object_id = o.object_id
                   ) rt) AS referencedBy,
                (SELECT COUNT(DISTINCT ofk.referenced_object_id)
                   FROM [${database}].sys.foreign_keys ofk
                   WHERE ofk.parent_object_id = o.object_id) AS referencesCount,
                (SELECT STRING_AGG(rt2.name, ',')
                   FROM (
                     SELECT DISTINCT ptt.name
                     FROM [${database}].sys.foreign_keys ofk2
                     JOIN [${database}].sys.tables ptt ON ptt.object_id = ofk2.referenced_object_id
                     WHERE ofk2.parent_object_id = o.object_id
                   ) rt2) AS referencesTables
        FROM [${database}].sys.tables o
        JOIN [${database}].sys.schemas s
                ON s.schema_id = o.schema_id
        LEFT JOIN [${database}].sys.columns c
                ON c.object_id = o.object_id
        LEFT JOIN [${database}].sys.foreign_keys fk
                ON fk.parent_object_id = o.object_id
        LEFT JOIN (
                SELECT object_id, SUM(row_count) AS [rowCount]
                FROM [${database}].sys.dm_db_partition_stats
                WHERE index_id IN (0, 1)
                GROUP BY object_id
        ) ps ON ps.object_id = o.object_id
        GROUP BY o.object_id, o.name, s.name, ps.[rowCount]
        ORDER BY o.name`)
      ).recordset;

      // Views: name + column count (views have no foreign keys -> 0)
      const views = (
        await r.query<TableInfo>(`
        SELECT v.name AS name,
               s.name AS schemaName,
               (SELECT COUNT(*) FROM [${database}].sys.columns c
                  WHERE c.object_id = v.object_id) AS fieldCount,
               0 AS fkCount,
               0 AS [rowCount],
               0 AS referencedByCount,
               CAST(NULL AS nvarchar(max)) AS referencedBy,
               0 AS referencesCount,
               CAST(NULL AS nvarchar(max)) AS referencesTables
        FROM [${database}].sys.views v
        JOIN [${database}].sys.schemas s ON s.schema_id = v.schema_id
        ORDER BY v.name`)
      ).recordset;

      // Row counts for views require a real query; guard each one
      for (const v of views) {
        try {
          const c = await r.query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM [${database}].[${v.schemaName}].[${v.name}]`
          );
          v.rowCount = c.recordset[0].n;
        } catch {
          v.rowCount = 0;
        }
      }

      return {
        Tables: tables,
        Views: views,
        'Stored Procedures': (
          await names(`SELECT name FROM [${database}].sys.objects WHERE type = 'P' ORDER BY name`)
        ).map((name) => ({ name })),
        Functions: (
          await names(
            `SELECT name FROM [${database}].sys.objects WHERE type IN ('FN','IF','TF') ORDER BY name`
          )
        ).map((name) => ({ name })),
        Triggers: (
          await names(
            `SELECT name FROM [${database}].sys.triggers WHERE is_ms_shipped = 0 ORDER BY name`
          )
        ).map((name) => ({ name })),
      };
    } finally {
      await pool.close();
    }
  }

  // Paginated + sorted list of tables (sorting/pagination done in SQL)
  static async listTables(
    connectionString: string,
    database: string,
    sort: string,
    dir: string,
    page: number,
    pageSize: number,
    filter: string,
    columnFilters: Record<string, string> = {},
    search = ''
  ): Promise<{ tables: TableInfo[]; total: number; page: number; pageSize: number }> {
    // Whitelist sort columns to avoid SQL injection
    const sortMap: Record<string, string> = {
      name: 'o.name',
      fieldCount: 'fieldCount',
      rowCount: '[rowCount]',
      fkCount: 'fkCount',
      referencedByCount: 'referencedByCount',
    };
    const orderCol = sortMap[sort] || 'o.name';
    const orderDir = String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeSize = Math.min(500, Math.max(1, Math.floor(pageSize) || 25));
    const offset = (safePage - 1) * safeSize;

    const escLike = (s: string): string => s.replace(/[%_[]/g, (m) => '[' + m + ']');

    // Per-column filters. The name column is filtered in WHERE; the aggregate
    // columns are filtered in HAVING (each converted to text for substring
    // LIKE). Column keys are whitelisted so they can never be used for
    // injection. A legacy single `filter` string maps onto the name column.
    const cf: Record<string, string> = { ...(columnFilters || {}) };
    const legacyName = (filter || '').trim();
    if (legacyName && !cf.name) cf.name = legacyName;

    const whereExpr: Record<string, string> = { name: 'o.name' };
    const havingExpr: Record<string, string> = {
      fieldCount: 'COUNT(DISTINCT c.column_id)',
      rowCount: 'ISNULL(ps.[rowCount], 0)',
      fkCount: 'COUNT(DISTINCT fk.object_id)',
      referencedByCount:
        `(SELECT COUNT(DISTINCT rfk.parent_object_id)
           FROM [${database}].sys.foreign_keys rfk
           WHERE rfk.referenced_object_id = o.object_id)`,
    };

    const inputs: { name: string; value: string | number }[] = [];
    const whereConds: string[] = [];
    const havingConds: string[] = [];
    let idx = 0;
    for (const [key, raw] of Object.entries(cf)) {
      const val = String(raw == null ? '' : raw).trim();
      if (!val) continue;
      const param = 'cf' + idx++;
      if (whereExpr[key]) {
        // The name column keeps case-insensitive substring matching.
        inputs.push({ name: param, value: '%' + escLike(val) + '%' });
        whereConds.push(`${whereExpr[key]} LIKE @${param}`);
      } else if (havingExpr[key]) {
        // The aggregate columns are numeric — support comparison operators
        // (=, >, <, >=, <=, !), ranges [min,max] and value lists (a,b,c), with
        // '=' as the default when no operator is given.
        const expr = havingExpr[key];
        const toNum = (s: string): number | null => {
          const n = Number(String(s).trim());
          return String(s).trim() !== '' && !Number.isNaN(n) ? n : null;
        };
        const range = val.match(/^\[\s*([^,\]]*?)\s*,\s*([^,\]]*?)\s*\]$/);
        const list = val.match(/^\(\s*(.*?)\s*\)$/);
        if (range && toNum(range[1]) !== null && toNum(range[2]) !== null) {
          const p1 = param + 'a';
          const p2 = param + 'b';
          inputs.push({ name: p1, value: toNum(range[1]) as number });
          inputs.push({ name: p2, value: toNum(range[2]) as number });
          havingConds.push(`${expr} BETWEEN @${p1} AND @${p2}`);
        } else if (list) {
          const nums = list[1].split(',').map(x => toNum(x)).filter(n => n !== null) as number[];
          if (nums.length) {
            const parts = nums.map((n, i) => {
              const p = param + 'i' + i;
              inputs.push({ name: p, value: n });
              return '@' + p;
            });
            havingConds.push(`${expr} IN (${parts.join(', ')})`);
          }
        } else {
          const { op, value } = parseFilterOperator(val);
          const num = toNum(value);
          if (num !== null) {
            inputs.push({ name: param, value: num });
            havingConds.push(`${expr} ${op} @${param}`);
          } else {
            inputs.push({ name: param, value: '%' + escLike(val) + '%' });
            havingConds.push(`CONVERT(NVARCHAR(64), ${expr}) LIKE @${param}`);
          }
        }
      }
    }
    // "Find tables by column name" search. Keeps only tables that have at
    // least one column whose name contains the typed term (case-insensitive).
    const searchTerm = (search || '').trim();
    if (searchTerm) {
      const sp = 'search';
      inputs.push({ name: sp, value: '%' + escLike(searchTerm) + '%' });
      whereConds.push(
        `EXISTS (SELECT 1 FROM [${database}].sys.columns sc
                   WHERE sc.object_id = o.object_id AND sc.name LIKE @${sp})`
      );
    }

    const whereClause = whereConds.length ? 'WHERE ' + whereConds.join(' AND ') : '';
    const havingClause = havingConds.length ? 'HAVING ' + havingConds.join(' AND ') : '';

    // When a column-name search is active, also surface the matching column
    // names per table so the UI can show a "Matches" column.
    const matchedColumnsSelect = searchTerm
      ? `,
                (SELECT STRING_AGG(mc.name, ', ')
                   FROM (
                     SELECT DISTINCT sc.name
                     FROM [${database}].sys.columns sc
                     WHERE sc.object_id = o.object_id AND sc.name LIKE @search
                   ) mc) AS matchedColumns`
      : '';

    const bindInputs = (req: import('mssql').Request): import('mssql').Request => {
      inputs.forEach((i) => req.input(i.name, i.value));
      return req;
    };

    const pool = await getPool(connectionString);
    try {
      const tables = (
        await bindInputs(pool.request()).query<TableInfo>(`
        SELECT o.name AS name,
                s.name AS schemaName,
                COUNT(DISTINCT c.column_id)  AS fieldCount,
                COUNT(DISTINCT fk.object_id) AS fkCount,
                ISNULL(ps.[rowCount], 0)     AS [rowCount],
                (SELECT COUNT(DISTINCT rfk.parent_object_id)
                   FROM [${database}].sys.foreign_keys rfk
                   WHERE rfk.referenced_object_id = o.object_id) AS referencedByCount,
                (SELECT STRING_AGG(rt.name, ',')
                   FROM (
                     SELECT DISTINCT pt.name
                     FROM [${database}].sys.foreign_keys rfk2
                     JOIN [${database}].sys.tables pt ON pt.object_id = rfk2.parent_object_id
                     WHERE rfk2.referenced_object_id = o.object_id
                   ) rt) AS referencedBy,
                (SELECT COUNT(DISTINCT ofk.referenced_object_id)
                   FROM [${database}].sys.foreign_keys ofk
                   WHERE ofk.parent_object_id = o.object_id) AS referencesCount,
                (SELECT STRING_AGG(rt2.name, ',')
                   FROM (
                     SELECT DISTINCT ptt.name
                     FROM [${database}].sys.foreign_keys ofk2
                     JOIN [${database}].sys.tables ptt ON ptt.object_id = ofk2.referenced_object_id
                     WHERE ofk2.parent_object_id = o.object_id
                   ) rt2) AS referencesTables${matchedColumnsSelect}
        FROM [${database}].sys.tables o
        JOIN [${database}].sys.schemas s
                ON s.schema_id = o.schema_id
        LEFT JOIN [${database}].sys.columns c
                ON c.object_id = o.object_id
        LEFT JOIN [${database}].sys.foreign_keys fk
                ON fk.parent_object_id = o.object_id
        LEFT JOIN (
                SELECT object_id, SUM(row_count) AS [rowCount]
                FROM [${database}].sys.dm_db_partition_stats
                WHERE index_id IN (0, 1)
                GROUP BY object_id
        ) ps ON ps.object_id = o.object_id
        ${whereClause}
        GROUP BY o.object_id, o.name, s.name, ps.[rowCount]
        ${havingClause}
        ORDER BY ${orderCol} ${orderDir}
        OFFSET ${offset} ROWS FETCH NEXT ${safeSize} ROWS ONLY`)
      ).recordset;

      const total = (
        await bindInputs(pool.request()).query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM (
             SELECT o.object_id
             FROM [${database}].sys.tables o
             JOIN [${database}].sys.schemas s
                     ON s.schema_id = o.schema_id
             LEFT JOIN [${database}].sys.columns c
                     ON c.object_id = o.object_id
             LEFT JOIN [${database}].sys.foreign_keys fk
                     ON fk.parent_object_id = o.object_id
             LEFT JOIN (
                     SELECT object_id, SUM(row_count) AS [rowCount]
                     FROM [${database}].sys.dm_db_partition_stats
                     WHERE index_id IN (0, 1)
                     GROUP BY object_id
             ) ps ON ps.object_id = o.object_id
             ${whereClause}
             GROUP BY o.object_id, o.name, s.name, ps.[rowCount]
             ${havingClause}
           ) x`
        )
      ).recordset[0].n;

      return { tables, total, page: safePage, pageSize: safeSize };
    } finally {
      await pool.close();
    }
  }

  // Column definitions for a single table or view
  static async listColumns(
    connectionString: string,
    database: string,
    schema: string,
    table: string
  ): Promise<ColumnInfo[]> {
    const pool = await getPool(connectionString);
    try {
      const objectId = `${qid(database)}.${qid(schema)}.${qid(table)}`.replace(/'/g, "''");
      const result = await pool.request().query<ColumnInfo>(`
        SELECT c.name AS name,
               t.name AS type,
               c.max_length AS maxLength,
               c.is_nullable AS isNullable,
               CAST(CASE WHEN ic.column_id IS NOT NULL THEN 1 ELSE 0 END AS bit) AS isPrimaryKey,
               CAST(CASE WHEN fkc.parent_column_id IS NOT NULL THEN 1 ELSE 0 END AS bit) AS isForeignKey,
               CAST(CASE WHEN uq.column_id IS NOT NULL THEN 1 ELSE 0 END AS bit) AS isUnique
        FROM ${qid(database)}.sys.columns c
        JOIN ${qid(database)}.sys.types t
          ON t.user_type_id = c.user_type_id
        LEFT JOIN ${qid(database)}.sys.indexes i
          ON i.object_id = c.object_id AND i.is_primary_key = 1
        LEFT JOIN ${qid(database)}.sys.index_columns ic
          ON ic.object_id = c.object_id AND ic.index_id = i.index_id AND ic.column_id = c.column_id
        LEFT JOIN (
          SELECT DISTINCT fkc.parent_object_id, fkc.parent_column_id
          FROM ${qid(database)}.sys.foreign_keys fk
          JOIN ${qid(database)}.sys.foreign_key_columns fkc
            ON fkc.constraint_object_id = fk.object_id
        ) fkc
          ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
        LEFT JOIN (
          SELECT DISTINCT uic.object_id, uic.column_id
          FROM ${qid(database)}.sys.indexes ui
          JOIN ${qid(database)}.sys.index_columns uic
            ON uic.object_id = ui.object_id AND uic.index_id = ui.index_id
          WHERE ui.is_unique = 1 AND ui.is_primary_key = 0
        ) uq
          ON uq.object_id = c.object_id AND uq.column_id = c.column_id
        WHERE c.object_id = OBJECT_ID('${objectId}')
        ORDER BY c.column_id`);
      return result.recordset;
    } finally {
      await pool.close();
    }
  }

  // Foreign-key relationships for a single table: the tables it references
  // (outgoing FKs) and the tables that reference it (incoming FKs).
  static async getRelations(
    connectionString: string,
    database: string,
    schema: string,
    table: string
  ): Promise<{ references: string[]; referencedBy: string[] }> {
    const pool = await getPool(connectionString);
    try {
      const objectId = `${qid(database)}.${qid(schema)}.${qid(table)}`.replace(/'/g, "''");
      const dbLit = database.replace(/'/g, "''");
      const result = await pool.request().query<{ name: string; dir: string }>(`
        SELECT DISTINCT OBJECT_NAME(fk.referenced_object_id, DB_ID('${dbLit}')) AS name, 'ref' AS dir
        FROM ${qid(database)}.sys.foreign_keys fk
        WHERE fk.parent_object_id = OBJECT_ID('${objectId}')
        UNION
        SELECT DISTINCT OBJECT_NAME(fk.parent_object_id, DB_ID('${dbLit}')) AS name, 'by' AS dir
        FROM ${qid(database)}.sys.foreign_keys fk
        WHERE fk.referenced_object_id = OBJECT_ID('${objectId}')`);
      const references: string[] = [];
      const referencedBy: string[] = [];
      for (const r of result.recordset) {
        if (!r.name) continue;
        if (r.dir === 'ref') references.push(r.name);
        else referencedBy.push(r.name);
      }
      return { references, referencedBy };
    } finally {
      await pool.close();
    }
  }

  // For each foreign-key column on a table, the referenced table/column and a
  // capped list of that referenced column's distinct values (for edit selects).
  static async getForeignKeyOptions(
    connectionString: string,
    database: string,
    schema: string,
    table: string
  ): Promise<{ column: string; refTable: string; refColumn: string; values: unknown[] }[]> {
    const pool = await getPool(connectionString);
    try {
      const objectId = `${qid(database)}.${qid(schema)}.${qid(table)}`.replace(/'/g, "''");
      const fkRes = await pool.request().query<{
        column: string;
        refSchema: string;
        refTable: string;
        refColumn: string;
      }>(`
        SELECT pc.name AS [column], rs.name AS refSchema, rt.name AS refTable, rc.name AS refColumn
        FROM ${qid(database)}.sys.foreign_key_columns fkc
        JOIN ${qid(database)}.sys.columns pc
          ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN ${qid(database)}.sys.columns rc
          ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        JOIN ${qid(database)}.sys.tables rt ON rt.object_id = fkc.referenced_object_id
        JOIN ${qid(database)}.sys.schemas rs ON rs.schema_id = rt.schema_id
        WHERE fkc.parent_object_id = OBJECT_ID('${objectId}')`);

      const out: { column: string; refTable: string; refColumn: string; values: unknown[] }[] = [];
      for (const fk of fkRes.recordset) {
        const vals = await pool.request().query<{ val: unknown }>(`
          SELECT DISTINCT TOP 1000 ${qid(fk.refColumn)} AS val
          FROM ${qid(database)}.${qid(fk.refSchema)}.${qid(fk.refTable)}
          WHERE ${qid(fk.refColumn)} IS NOT NULL
          ORDER BY ${qid(fk.refColumn)}`);
        out.push({
          column: fk.column,
          refTable: fk.refTable,
          refColumn: fk.refColumn,
          values: vals.recordset.map((r) => r.val),
        });
      }
      return out;
    } finally {
      await pool.close();
    }
  }

  // All foreign-key edges in a database (parent -> referenced) plus the number
  // of tables that have no foreign-key relationship in either direction.
  static async getDbRelations(
    connectionString: string,
    database: string
  ): Promise<{ edges: { from: string; to: string }[]; isolatedCount: number; isolatedTables: string[] }> {
    const pool = await getPool(connectionString);
    try {
      const dbLit = database.replace(/'/g, "''");
      const edgeResult = await pool.request().query<{ from: string; to: string }>(`
        SELECT DISTINCT
          OBJECT_NAME(fk.parent_object_id, DB_ID('${dbLit}')) AS [from],
          OBJECT_NAME(fk.referenced_object_id, DB_ID('${dbLit}')) AS [to]
        FROM ${qid(database)}.sys.foreign_keys fk`);
      const isolatedResult = await pool.request().query<{ name: string }>(`
        SELECT t.name AS name
        FROM ${qid(database)}.sys.tables t
        WHERE t.is_ms_shipped = 0
          AND NOT EXISTS (
            SELECT 1 FROM ${qid(database)}.sys.foreign_keys fk
            WHERE fk.parent_object_id = t.object_id
               OR fk.referenced_object_id = t.object_id
          )
        ORDER BY t.name`);
      const edges = edgeResult.recordset
        .filter(r => r.from && r.to && r.from !== r.to)
        .map(r => ({ from: r.from, to: r.to }));
      const isolatedTables = isolatedResult.recordset.map(r => r.name).filter(Boolean);
      return { edges, isolatedCount: isolatedTables.length, isolatedTables };
    } finally {
      await pool.close();
    }
  }

  // Runs an arbitrary SQL batch against the given database and returns every
  // result set it produces (each capped) plus affected-row counts. Used by the
  // SQL editor tab.
  static async runQuery(
    connectionString: string,
    database: string,
    sqlText: string
  ): Promise<{
    resultSets: { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }[];
    rowsAffected: number[];
  }> {
    const MAX_ROWS = 1000;
    const pool = await getPool(connectionString);
    try {
      const result = await pool.request().query(`USE ${qid(database)};\n${sqlText}`);
      const sets = (result.recordsets as unknown as Array<Record<string, unknown>[]>) || [];
      const resultSets = sets.map((set) => {
        const rowsAll = (set as Record<string, unknown>[]) || [];
        const colMeta = (set as unknown as { columns?: Record<string, unknown> }).columns;
        const columns = colMeta
          ? Object.keys(colMeta)
          : rowsAll[0]
            ? Object.keys(rowsAll[0])
            : [];
        return {
          columns,
          rows: rowsAll.slice(0, MAX_ROWS),
          truncated: rowsAll.length > MAX_ROWS,
        };
      });
      return {
        resultSets,
        rowsAffected: result.rowsAffected || [],
      };
    } finally {
      await pool.close();
    }
  }

  // Completion schema for the SQL editor: a map of table/view name -> column
  // names, for the given database. Both the bare name and the schema-qualified
  // name are included so either form autocompletes.
  static async getSchema(
    connectionString: string,
    database: string
  ): Promise<Record<string, string[]>> {
    const pool = await getPool(connectionString);
    try {
      const result = await pool.request().query<{
        schemaName: string;
        tableName: string;
        columnName: string;
      }>(`
        SELECT s.name AS schemaName, t.name AS tableName, c.name AS columnName
        FROM ${qid(database)}.sys.columns c
        JOIN ${qid(database)}.sys.objects t ON t.object_id = c.object_id
        JOIN ${qid(database)}.sys.schemas s ON s.schema_id = t.schema_id
        WHERE t.type IN ('U', 'V')
        ORDER BY s.name, t.name, c.column_id`);
      const schema: Record<string, string[]> = {};
      for (const r of result.recordset) {
        if (!r.tableName || !r.columnName) continue;
        const bare = r.tableName;
        const qualified = `${r.schemaName}.${r.tableName}`;
        (schema[bare] ||= []).push(r.columnName);
        (schema[qualified] ||= []).push(r.columnName);
      }
      return schema;
    } finally {
      await pool.close();
    }
  }

  // Full T-SQL definition of a module-based object (view, stored procedure,
  // function or trigger). Schema is optional; when omitted the object is
  // resolved by name alone.
  static async getViewDefinition(
    connectionString: string,
    database: string,
    schema: string,
    view: string
  ): Promise<string> {
    const pool = await getPool(connectionString);
    try {
      const result = await pool
        .request()
        .input('name', view)
        .input('schema', schema || '')
        .query<{ definition: string | null }>(`
        SELECT TOP 1 m.definition AS definition
        FROM ${qid(database)}.sys.sql_modules m
        JOIN ${qid(database)}.sys.objects o ON o.object_id = m.object_id
        LEFT JOIN ${qid(database)}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.name = @name AND (@schema = N'' OR s.name = @schema)`);
      const row = result.recordset[0];
      return (row && row.definition) || '';
    } finally {
      await pool.close();
    }
  }

  // Paginated rows for a single table or view
  static async getTableData(
    connectionString: string,
    database: string,
    schema: string,
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
    const pool = await getPool(connectionString);
    try {
      const full = `${qid(database)}.${qid(schema)}.${qid(table)}`;
      const p = Math.max(1, Math.floor(page) || 1);
      const ps = Math.min(200, Math.max(1, Math.floor(pageSize) || 50));
      const offset = (p - 1) * ps;

      // Build the optional WHERE clause from a cross-column search term and/or
      // per-column filters. Every column is safely converted to text and
      // matched with LIKE; collation controls case sensitivity and fuzzy mode
      // interleaves wildcards between characters. Column names are validated
      // against the real schema so they can never be used for injection.
      const term = (search || '').trim();
      const filterEntries = Object.entries(columnFilters || {})
        .filter(([, v]) => v != null && String(v).trim() !== '');

      let realCols: string[] = [];
      const colTypes = new Map<string, string>();
      if (term || filterEntries.length || (sortColumn || '').trim()) {
        const colsRes = await pool
          .request()
          .input('schema', schema)
          .input('table', table)
          .query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
            `SELECT COLUMN_NAME, DATA_TYPE FROM ${qid(database)}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table`
          );
        realCols = colsRes.recordset.map(r => r.COLUMN_NAME);
        colsRes.recordset.forEach(r => colTypes.set(r.COLUMN_NAME.toLowerCase(), r.DATA_TYPE));
      }

      const escLike = (s: string): string => s.replace(/[%_[]/g, m => '[' + m + ']');
      const inputs: { name: string; value: string }[] = [];
      const clauses: string[] = [];

      if (term && realCols.length) {
        const collation = caseSensitive ? 'Latin1_General_CS_AS' : 'Latin1_General_CI_AS';
        const pattern = fuzzy
          ? '%' + [...term].map(escLike).join('%') + '%'
          : '%' + escLike(term) + '%';
        inputs.push({ name: 'search', value: pattern });
        const conds = realCols.map(
          c => `TRY_CONVERT(NVARCHAR(MAX), ${qid(c)}) COLLATE ${collation} LIKE @search`
        );
        clauses.push('(' + conds.join(' OR ') + ')');
      }

      const lowerReal = new Set(realCols.map(c => c.toLowerCase()));
      filterEntries.forEach(([col, val], i) => {
        // Only accept filters for columns that actually exist in the table.
        if (!lowerReal.has(String(col).toLowerCase())) return;
        const param = 'cf' + i;
        const type = colTypes.get(String(col).toLowerCase()) || '';
        const raw = String(val).trim();
        // Numeric/date columns support comparison operators (=, >, <, >=, <=, !),
        // ranges [min,max] and value lists (a,b,c); everything else keeps the
        // case-insensitive substring LIKE behaviour.
        if (isNumericType(type) || isDateType(type)) {
          const convType = isDateType(type) ? 'DATETIME2' : 'FLOAT';
          const converted = `TRY_CONVERT(${convType}, ${qid(col)})`;
          const clause = buildTypedFilterClause(
            converted,
            raw,
            param,
            name => `TRY_CONVERT(${convType}, @${name})`,
            (name, value) => inputs.push({ name, value })
          );
          if (clause) clauses.push(clause);
        } else {
          inputs.push({ name: param, value: '%' + escLike(raw) + '%' });
          clauses.push(
            `TRY_CONVERT(NVARCHAR(MAX), ${qid(col)}) COLLATE Latin1_General_CI_AS LIKE @${param}`
          );
        }
      });

      const whereClause = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

      // Optional ORDER BY. The requested column is validated against the real
      // schema so it can never be used for injection; direction is a literal.
      let orderBy = 'ORDER BY (SELECT NULL)';
      const sortCol = (sortColumn || '').trim();
      if (sortCol && realCols.some(c => c.toLowerCase() === sortCol.toLowerCase())) {
        const realName = realCols.find(c => c.toLowerCase() === sortCol.toLowerCase()) as string;
        const dir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        orderBy = `ORDER BY ${qid(realName)} ${dir}`;
      }

      const countReq = pool.request();
      inputs.forEach(i => countReq.input(i.name, i.value));
      const countRes = await countReq.query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${full} ${whereClause}`
      );
      const total = countRes.recordset[0].total;

      const dataReq = pool.request().input('offset', offset).input('ps', ps);
      inputs.forEach(i => dataReq.input(i.name, i.value));
      const dataRes = await dataReq.query(
        `SELECT * FROM ${full} ${whereClause} ${orderBy} OFFSET @offset ROWS FETCH NEXT @ps ROWS ONLY`
      );

      const meta = (dataRes.recordset as unknown as { columns?: Record<string, unknown> }).columns;
      const columns = meta
        ? Object.keys(meta)
        : dataRes.recordset[0]
          ? Object.keys(dataRes.recordset[0])
          : [];

      // Build a display-only version of the executed query with parameter
      // values inlined as literals, so the UI can show exactly what is being
      // returned for the current page/filters/sort.
      let sql = `SELECT * FROM ${full}`;
      if (whereClause) sql += '\n' + whereClause;
      sql += `\n${orderBy}`;
      sql += `\nOFFSET ${offset} ROWS FETCH NEXT ${ps} ROWS ONLY`;
      inputs.forEach(i => {
        const lit = "'" + String(i.value).replace(/'/g, "''") + "'";
        sql = sql.replace(new RegExp('@' + i.name + '\\b', 'g'), lit);
      });

      return { columns, rows: dataRes.recordset as Record<string, unknown>[], total, page: p, pageSize: ps, sql };
    } finally {
      await pool.close();
    }
  }
}
