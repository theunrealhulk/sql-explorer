import { Request, Response } from 'express';
import { getModel } from '../models/DbModel';

export class DatabaseController {
  static async connect(req: Request, res: Response): Promise<void> {
    try {
      const databases = await getModel(req.body.connectionString).listDatabases(req.body.connectionString);
      res.json({ ok: true, databases });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async dbStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await getModel(req.body.connectionString).listDatabaseStats(req.body.connectionString);
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async objects(req: Request, res: Response): Promise<void> {
    const { connectionString, database } = req.body;
    try {
      const categories = await getModel(connectionString).listObjects(connectionString, database);
      res.json({ ok: true, categories });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async tables(req: Request, res: Response): Promise<void> {
    const { connectionString, database, sort, dir, page, pageSize, filter, columnFilters, search } = req.body;
    try {
      const result = await getModel(connectionString).listTables(
        connectionString,
        database,
        sort || 'name',
        dir || 'ASC',
        page || 1,
        pageSize || 25,
        filter || '',
        columnFilters || {},
        search || ''
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async columns(req: Request, res: Response): Promise<void> {
    const { connectionString, database, schema, table } = req.body;
    try {
      const columns = await getModel(connectionString).listColumns(connectionString, database, schema, table);
      res.json({ ok: true, columns });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async data(req: Request, res: Response): Promise<void> {
    const { connectionString, database, schema, table, page, pageSize, search, fuzzy, caseSensitive, columnFilters, sortColumn, sortDir } = req.body;
    try {
      const result = await getModel(connectionString).getTableData(
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
      const result = await getModel(connectionString).getRelations(connectionString, database, schema, table);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async dbRelations(req: Request, res: Response): Promise<void> {
    const { connectionString, database } = req.body;
    try {
      const result = await getModel(connectionString).getDbRelations(connectionString, database);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async viewDefinition(req: Request, res: Response): Promise<void> {
    const { connectionString, database, schema, view } = req.body;
    try {
      const definition = await getModel(connectionString).getViewDefinition(connectionString, database, schema, view);
      res.json({ ok: true, definition });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async schema(req: Request, res: Response): Promise<void> {
    const { connectionString, database } = req.body;
    try {
      const schema = await getModel(connectionString).getSchema(connectionString, database);
      res.json({ ok: true, schema });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async query(req: Request, res: Response): Promise<void> {
    const { connectionString, database, sql } = req.body;
    try {
      const result = await getModel(connectionString).runQuery(connectionString, database, sql || '');
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static async editMeta(req: Request, res: Response): Promise<void> {
    const { connectionString, database, schema, table } = req.body;
    try {
      const model = getModel(connectionString);
      const [columns, fkOptions] = await Promise.all([
        model.listColumns(connectionString, database, schema, table),
        model.getForeignKeyOptions(connectionString, database, schema, table),
      ]);
      res.json({ ok: true, columns, fkOptions });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  }

  static config(_req: Request, res: Response): void {
    res.json({ connectionString: process.env.DEFAULT_CONNECTION_STRING || '' });
  }

  // Receives an uploaded SQLite file (via multer) and returns a connection
  // string pointing at the stored copy on the server.
  static uploadSqlite(req: Request, res: Response): void {
    const file = (req as Request & { file?: { path: string } }).file;
    if (!file) {
      res.status(400).json({ ok: false, error: 'No file uploaded' });
      return;
    }
    res.json({ ok: true, connectionString: `Data Source=${file.path};` });
  }

}
