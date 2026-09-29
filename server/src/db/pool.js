import pg from 'pg';

// NUMERIC comes back as a string by default; ratings are small decimals, so parse them.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => parseInt(v, 10));
// Keep DATE columns as 'YYYY-MM-DD' strings instead of timezone-shifted JS Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const query = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;
export const many = async (text, params) => (await pool.query(text, params)).rows;
