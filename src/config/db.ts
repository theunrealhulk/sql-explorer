import sql from 'mssql';

// Opens a fresh pool for a given connection string.
export async function getPool(connectionString: string): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool(connectionString);
  await pool.connect();
  return pool;
}
