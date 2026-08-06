import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';

const PORT = parseInt(process.env.PORT || '9988', 10);
const SHARED_SECRET_KEY = process.env.SHARED_SECRET_KEY || 'flashkit-secure-token-2026';

// Active Workstation Agents: agentId -> WebSocket
const agents = new Map<string, { ws: WebSocket; name: string; ip: string }>();

// Active Dashboards: WebSocket client set
const dashboards = new Set<WebSocket>();

const wss = new WebSocketServer({ port: PORT });

console.log(`🚀 FlashKit Cloud Broker listening on port ${PORT}`);

// Helper to broadcast status changes to dashboards
function broadcastAgentList() {
  const list = Array.from(agents.entries()).map(([id, info]) => ({
    id,
    name: info.name,
    ip: info.ip,
  }));
  const payload = JSON.stringify({ type: 'agent_list', agents: list });
  for (const dash of dashboards) {
    if (dash.readyState === WebSocket.OPEN) {
      dash.send(payload);
    }
  }
}

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const { pathname, query } = parseUrl(req.url || '', true);
  const token = query.token;

  // 1. Authenticate Token
  if (!token || token !== SHARED_SECRET_KEY) {
    console.log(`❌ Unauthorized connection attempt from ${req.socket.remoteAddress}`);
    ws.close(4001, 'Unauthorized');
    return;
  }

  // 2. Handle Connection Types based on Path
  if (pathname === '/ws/agent') {
    const agentId = (query.agent_id as string) || `agent-${Math.random().toString(36).substring(2, 9)}`;
    const agentName = (query.name as string) || 'Unnamed Workstation';
    const remoteIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';

    console.log(`🔌 Agent connected: ${agentName} (${agentId}) from ${remoteIp}`);
    
    // Disconnect old session if agentId re-registers
    if (agents.has(agentId)) {
      console.log(`⚠️ Disconnecting duplicate agent session: ${agentId}`);
      agents.get(agentId)?.ws.close(4002, 'Duplicate registration');
    }

    agents.set(agentId, { ws, name: agentName, ip: remoteIp });
    broadcastAgentList();

    ws.on('message', (message: string) => {
      // Forward all agent messages (logs, progress, device updates) to all active dashboards
      try {
        const rawStr = message.toString();
        const parsed = JSON.parse(rawStr);
        // Inject sender metadata
        parsed.agent_id = agentId;
        const relayMsg = JSON.stringify(parsed);

        for (const dash of dashboards) {
          if (dash.readyState === WebSocket.OPEN) {
            dash.send(relayMsg);
          }
        }
      } catch (err) {
        console.error(`Error parsing agent message:`, err);
      }
    });

    ws.on('close', () => {
      console.log(`🔌 Agent disconnected: ${agentName} (${agentId})`);
      agents.delete(agentId);
      broadcastAgentList();
    });

    ws.on('error', (err) => {
      console.error(`Agent socket error (${agentId}):`, err);
    });

  } else if (pathname === '/ws/dashboard') {
    console.log(`🖥️ Dashboard client connected`);
    dashboards.add(ws);

    // Instantly send agent list to new dashboard connection
    broadcastAgentList();

    ws.on('message', (message: string) => {
      // Commands from dashboard: must target a specific agent
      // Format: { target: "agent_id", payload: { command: "start_flash", ... } }
      try {
        const rawStr = message.toString();
        const parsed = JSON.parse(rawStr);
        const targetAgentId = parsed.target;

        if (targetAgentId && agents.has(targetAgentId)) {
          const agentInfo = agents.get(targetAgentId);
          if (agentInfo && agentInfo.ws.readyState === WebSocket.OPEN) {
            agentInfo.ws.send(JSON.stringify(parsed.payload));
          }
        } else {
          ws.send(JSON.stringify({ type: 'error', message: `Target agent ${targetAgentId} is offline or not found` }));
        }
      } catch (err) {
        console.error(`Error parsing dashboard command:`, err);
      }
    });

    ws.on('close', () => {
      console.log(`🖥️ Dashboard client disconnected`);
      dashboards.delete(ws);
    });

    ws.on('error', (err) => {
      console.error(`Dashboard socket error:`, err);
    });
  } else {
    console.log(`❌ Invalid connection path: ${pathname}`);
    ws.close(4004, 'Invalid path');
  }
});

// Ping interval to keep connections alive and prune dead connections
const interval = setInterval(() => {
  wss.clients.forEach((ws: any) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});
