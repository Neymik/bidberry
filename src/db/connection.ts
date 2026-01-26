import mysql from 'mysql2/promise';
import type { Pool, PoolConnection } from 'mysql2/promise';

let pool: Pool | null = null;

export interface DBConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function getDBConfig(): DBConfig {
  return {
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER || 'wb_user',
    password: process.env.MYSQL_PASSWORD || 'wb_password',
    database: process.env.MYSQL_DATABASE || 'wb_analytics',
  };
}

export async function getPool(): Promise<Pool> {
  if (!pool) {
    const config = getDBConfig();
    pool = mysql.createPool({
      ...config,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
  }
  return pool;
}

export async function getConnection(): Promise<PoolConnection> {
  const p = await getPool();
  return p.getConnection();
}

export async function query<T>(sql: string, params?: any[]): Promise<T> {
  const p = await getPool();
  const [rows] = await p.query(sql, params);
  return rows as T;
}

export async function execute(sql: string, params?: any[]): Promise<any> {
  const p = await getPool();
  const [result] = await p.execute(sql, params);
  return result;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function checkConnection(): Promise<boolean> {
  try {
    const p = await getPool();
    await p.query('SELECT 1');
    return true;
  } catch (error) {
    console.error('Database connection error:', error);
    return false;
  }
}

export async function transaction<T>(
  callback: (connection: PoolConnection) => Promise<T>
): Promise<T> {
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
