// Shared by API, workers and operator scripts. No AWS access in application code.
function databaseOptions(env = process.env) {
  const name = env.APP_DB_NAME;
  if (name === undefined || name === '') return {}; // legacy/local URI selection
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('APP_DB_NAME must be a database name, not a connection string');
  return { dbName: name };
}
module.exports = { databaseOptions };
