const fs = require('fs');
const path = require('path');
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split(/\r?\n/).forEach((line) => {
      const [key, ...rest] = line.split('=');
      if (!key || key.trim().startsWith('#')) return;
      process.env[key.trim()] = rest.join('=');
    });
  }
}
loadEnv();
module.exports = {
  env: process.env,
};
