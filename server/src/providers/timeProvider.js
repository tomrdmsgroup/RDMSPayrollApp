function now() {
  return new Date();
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
module.exports = { now, today };
