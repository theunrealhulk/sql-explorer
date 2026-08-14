import { SqlServerModel } from './SqlServerModel';
import { SqliteModel, isSqliteConnectionString } from './SqliteModel';
import { DbProvider } from './DbProvider';

// Selects the data-access provider for a given connection string. SQLite files
// are routed to the better-sqlite3 based provider; everything else uses SQL
// Server. The return type is the engine-agnostic DbProvider contract so callers
// stay decoupled from the concrete engine implementation.
export function getModel(connectionString: string): DbProvider {
  return isSqliteConnectionString(connectionString) ? SqliteModel : SqlServerModel;
}
