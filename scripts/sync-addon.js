const fs = require('fs');
const path = require('path');

function syncAddon() {
  console.log('Syncing files from dashboard/ to addons/solar_forecast/ ...');
  const srcServer = path.join(__dirname, '..', 'dashboard', 'server.js');
  const dstServer = path.join(__dirname, '..', 'addons', 'solar_forecast', 'server.js');
  fs.copyFileSync(srcServer, dstServer);

  const srcPublic = path.join(__dirname, '..', 'dashboard', 'public');
  const dstPublic = path.join(__dirname, '..', 'addons', 'solar_forecast', 'public');
  if (!fs.existsSync(dstPublic)) fs.mkdirSync(dstPublic, { recursive: true });

  for (const file of fs.readdirSync(srcPublic)) {
    const s = path.join(srcPublic, file);
    const d = path.join(dstPublic, file);
    if (fs.statSync(s).isFile()) {
      fs.copyFileSync(s, d);
      console.log(`Copied public/${file}`);
    }
  }
  console.log('Sync complete!');
}

syncAddon();
