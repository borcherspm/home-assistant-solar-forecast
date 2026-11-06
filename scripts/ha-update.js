const fs = require('fs');

function getToken() {
  const env = fs.readFileSync('.env', 'utf8');
  return env
    .split('\n')
    .find((l) => l.startsWith('HOME_ASSISTANT_TOKEN='))
    ?.split('=')[1]
    ?.trim()
    ?.replace(/^["']|["']$/g, '');
}

async function updateAddon() {
  const token = getToken();
  console.log('Connecting to Home Assistant WebSocket API...');
  const ws = new WebSocket('ws://homeassistant.local:8123/api/websocket');

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: token }));
    } else if (msg.type === 'auth_ok') {
      console.log('1. Reloading Add-on Store (fetching latest GitHub commits)...');
      ws.send(
        JSON.stringify({
          id: 1,
          type: 'supervisor/api',
          endpoint: '/store/reload',
          method: 'post'
        })
      );
    } else if (msg.id === 1) {
      console.log('2. Store reloaded. Triggering add-on update/rebuild...');
      ws.send(
        JSON.stringify({
          id: 2,
          type: 'supervisor/api',
          endpoint: '/addons/cad53091_solar_forecast/update',
          method: 'post'
        })
      );
    } else if (msg.id === 2) {
      if (msg.success) {
        console.log('3. Update completed successfully! Fetching status...');
      } else {
        console.warn('Update note:', msg.error?.message || 'Retrying via rebuild...');
      }
      ws.send(
        JSON.stringify({
          id: 3,
          type: 'supervisor/api',
          endpoint: '/addons/cad53091_solar_forecast/info',
          method: 'get'
        })
      );
    } else if (msg.id === 3) {
      const info = msg.result || {};
      console.log('--- Add-on Status After Update ---');
      console.log('State:          ', info.state);
      console.log('Active Version: ', info.version);
      console.log('Latest Version: ', info.version_latest);
      ws.close();
    }
  };
}

updateAddon().catch(console.error);
