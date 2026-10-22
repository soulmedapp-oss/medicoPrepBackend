// Only explicit dev environments expose the non-sensitive connected DB name.
function devBuildInfo(connection, env = process.env) {
  if (env.APP_ENV !== 'dev') return { status: 404, body: { error: 'Not found' } };
  if (connection.readyState !== 1) return { status: 503, body: { error: 'Database not ready' } };
  return { status: 200, body: { environment: 'dev', database: connection.name } };
}
module.exports = { devBuildInfo };
