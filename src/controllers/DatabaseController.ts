import { Request, Response } from 'express';
import { SqlServerModel } from '../models/SqlServerModel';

export class DatabaseController {
  static async connect(req: Request, res: Response): Promise<void> {
    try {
      const databases = await SqlServerModel.listDatabases(req.body.connectionString);
      res.json({ ok: true, databases });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async dbStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await SqlServerModel.listDatabaseStats(req.body.connectionString);
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async objects(req: Request, res: Response): Promise<void> {
    const { connectionString, database } = req.body;
    try {
      const categories = await SqlServerModel.listObjects(connectionString, database);
      res.json({ ok: true, categories });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async tables(req: Request, res: Response): Promise<void> {
    const { connectionString, database, sort, dir, page, pageSize, filter } = req.body;
    try {
      const result = await SqlServerModel.listTables(
        connectionString,
        database,
        sort || 'name',
        dir || 'ASC',
        page || 1,
        pageSize || 25,
        filter || ''
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async columns(req: Request, res: Response): Promise<void> {
    const { connectionString, database, schema, table } = req.body;
    try {
      const columns = await SqlServerModel.listColumns(connectionString, database, schema, table);
      res.json({ ok: true, columns });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async data(req: Request, res: Response): Promise<void> {
    const { connectionString, database, schema, table, page, pageSize, search, fuzzy, caseSensitive, columnFilters, sortColumn, sortDir } = req.body;
    try {
      const result = await SqlServerModel.getTableData(
        connectionString,
        database,
        schema,
        table,
        page || 1,
        pageSize || 50,
        search || '',
        !!fuzzy,
        !!caseSensitive,
        columnFilters || {},
        sortColumn || '',
        sortDir || ''
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async relations(req: Request, res: Response): Promise<void> {
    const { connectionString, database, schema, table } = req.body;
    try {
      const result = await SqlServerModel.getRelations(connectionString, database, schema, table);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async dbRelations(req: Request, res: Response): Promise<void> {
    const { connectionString, database } = req.body;
    try {
      const result = await SqlServerModel.getDbRelations(connectionString, database);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async viewDefinition(req: Request, res: Response): Promise<void> {
    const { connectionString, database, schema, view } = req.body;
    try {
      const definition = await SqlServerModel.getViewDefinition(connectionString, database, schema, view);
      res.json({ ok: true, definition });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async schema(req: Request, res: Response): Promise<void> {
    const { connectionString, database } = req.body;
    try {
      const schema = await SqlServerModel.getSchema(connectionString, database);
      res.json({ ok: true, schema });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async query(req: Request, res: Response): Promise<void> {
    const { connectionString, database, sql } = req.body;
    try {
      const result = await SqlServerModel.runQuery(connectionString, database, sql || '');
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async editMeta(req: Request, res: Response): Promise<void> {
    const { connectionString, database, schema, table } = req.body;
    try {
      const [columns, fkOptions] = await Promise.all([
        SqlServerModel.listColumns(connectionString, database, schema, table),
        SqlServerModel.getForeignKeyOptions(connectionString, database, schema, table),
      ]);
      res.json({ ok: true, columns, fkOptions });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static config(_req: Request, res: Response): void {
    res.json({ connectionString: process.env.DEFAULT_CONNECTION_STRING || '' });
  }
}
