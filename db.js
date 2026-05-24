const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
    })
  : null;

async function testDbConnection() {
  if (!pool) {
    console.log('POSTGRES SKIPPED: DATABASE_URL not set');
    return;
  }

  const result = await pool.query('SELECT NOW() AS now');
  console.log('POSTGRES OK:', result.rows[0].now);
}

module.exports = {
  pool,
  testDbConnection,
};
