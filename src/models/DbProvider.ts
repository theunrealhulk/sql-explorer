import {
  TableInfo,
  ColumnInfo,
  TableData,
  ObjectCategories,
  DatabaseStat,
} from './SqlServerModel';

// Engine-agnostic data-access contract. Both SqlServerModel and SqliteModel
// implement this shape (as static methods), so controllers and any shared code
// can operate without depending on a specific database engine.
export interface DbProvider {
  listDatabases(connectionString: string): Promise<string[]>;

  listDatabaseStats(connectionString: string): Promise<DatabaseStat[]>;

  listObjects(connectionString: string, database: string): Promise<ObjectCategories>;

  listTables(
    connectionString: string,
    database: string,
    sort: string,
    dir: string,
    page: number,
    pageSize: number,
    filter: string,
    columnFilters?: Record<string, string>,
    search?: string
  ): Promise<{ tables: TableInfo[]; total: number; page: number; pageSize: number }>;

  listColumns(
    connectionString: string,
    database: string,
    schema: string,
    table: string
  ): Promise<ColumnInfo[]>;

  getRelations(
    connectionString: string,
    database: string,
    schema: string,
    table: string
  ): Promise<{ references: string[]; referencedBy: string[] }>;

  getForeignKeyOptions(
    connectionString: string,
    database: string,
    schema: string,
    table: string
  ): Promise<{ column: string; refTable: string; refColumn: string; values: unknown[] }[]>;

  getDbRelations(
    connectionString: string,
    database: string
  ): Promise<{
    edges: { from: string; to: string }[];
    isolatedCount: number;
    isolatedTables: string[];
  }>;

  runQuery(
    connectionString: string,
    database: string,
    sqlText: string
  ): Promise<{
    resultSets: { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }[];
    rowsAffected: number[];
  }>;

  getSchema(connectionString: string, database: string): Promise<Record<string, string[]>>;

  getViewDefinition(
    connectionString: string,
    database: string,
    schema: string,
    view: string
  ): Promise<string>;

  getTableData(
    connectionString: string,
    database: string,
    schema: string,
    table: string,
    page: number,
    pageSize: number,
    search?: string,
    fuzzy?: boolean,
    caseSensitive?: boolean,
    columnFilters?: Record<string, string>,
    sortColumn?: string,
    sortDir?: string
  ): Promise<TableData>;
}
