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

async function checkStatus() {
  const token = getToken();
  const ws = new WebSocket('ws://homeassistant.local:8123/api/websocket');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: token }));
    } else if (msg.type === 'auth_ok') {
      ws.send(
        JSON.stringify({
          id: 1,
          type: 'supervisor/api',
          endpoint: '/addons/cad53091_solar_forecast/info',
          method: 'get'
        })
      );
    } else if (msg.id === 1) {
      const info = msg.result || {};
      console.log('--- Home Assistant Solar Forecast Add-on Status ---');
      console.log('State:           ', info.state);
      console.log('Current Version: ', info.version);
      console.log('Latest Version:  ', info.version_latest);
      console.log('Update Available:', info.update_available);
      console.log('Ingress URL:     ', info.ingress_url);
      ws.close();
    }
  };
}

checkStatus().catch(console.error);
