import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  console.log('[WebSocket] Connected');
  
  // Send auth
  ws.send(JSON.stringify({
    type: 'req',
    id: 1,
    method: 'connect',
    params: {
      token: 'nano-claw-web-secret-change-me',
      client: 'test',
      role: 'user'
    }
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[WebSocket]', JSON.stringify(msg, null, 2));
  
  if (msg.type === 'res' && msg.id === 1 && msg.ok) {
    // Send chat message
    ws.send(JSON.stringify({
      type: 'req',
      id: 2,
      method: 'chat.send',
      params: {
        sessionKey: 'agent:lucy:web:ws-test-123',
        message: 'Hello from WebSocket test!'
      }
    }));
  }
  
  if (msg.type === 'event' && msg.event === 'chat' && msg.payload.state === 'final') {
    console.log('\n[SUCCESS] Got final response:', msg.payload.content);
    ws.close();
    setTimeout(() => process.exit(0), 1000);
  }
  
  if (msg.type === 'res' && msg.id === 2 && !msg.ok) {
    console.log('\n[ERROR]', msg.payload);
    ws.close();
    setTimeout(() => process.exit(1), 1000);
  }
});

ws.on('error', (err) => {
  console.error('[WebSocket] Error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('[WebSocket] Closed');
});

// Timeout after 30 seconds
setTimeout(() => {
  console.log('[WebSocket] Timeout');
  process.exit(1);
}, 30000);
