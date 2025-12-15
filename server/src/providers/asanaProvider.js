function createTask({ title, description }) {
  return { id: `asana-${Date.now()}`, title, description };
}
module.exports = { createTask };
