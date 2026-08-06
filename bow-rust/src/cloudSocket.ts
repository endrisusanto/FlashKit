type Callback = (...args: any[]) => void;

class CloudSocket {
  private ws: WebSocket | null = null;
  private url: string = '';
  private token: string = '';
  private agentId: string = '';
  private reconnectTimer: any = null;
  private isConnecting: boolean = false;
  private active: boolean = false;

  // Custom Event Emitter implementation for browser environment
  private listeners: Record<string, Callback[]> = {};

  public on(event: string, cb: Callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(cb);
  }

  public off(event: string, cb: Callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(l => l !== cb);
  }

  private emit(event: string, ...args: any[]) {
    if (!this.listeners[event]) return;
    for (const cb of this.listeners[event]) {
      try {
        cb(...args);
      } catch (e) {
        console.error(`Error in event listener for ${event}:`, e);
      }
    }
  }

  public setup(url: string, token: string) {
    const isWs = url.startsWith('ws://') || url.startsWith('wss://');
    this.active = isWs;

    if (!isWs) {
      this.disconnect();
      return;
    }

    try {
      const parsedUrl = new URL(url);
      this.agentId = parsedUrl.searchParams.get('agent_id') || '';
      parsedUrl.search = '';
      this.url = parsedUrl.toString();
    } catch (e) {
      this.url = url;
    }

    this.token = token;
    this.connect();
  }

  public isActive(): boolean {
    return this.active;
  }

  public getAgentId(): string {
    return this.agentId;
  }

  private connect() {
    if (this.isConnecting || !this.active) return;
    this.isConnecting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const wsUrl = `${this.url}/ws/dashboard?token=${encodeURIComponent(this.token)}`;
    console.log(`🔌 CloudSocket: Connecting to ${wsUrl}`);
    
    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('🔌 CloudSocket: Connected to Cloud Broker');
        this.isConnecting = false;
        this.emit('status', 'Online');
      };

      this.ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          
          if (parsed.agent_id && parsed.agent_id !== this.agentId) {
            return;
          }

          if (parsed.type === 'shared_ui_state') {
            this.emit('shared_ui_state', parsed.state);
          } else if (parsed.type === 'progress') {
            this.emit('progress', parsed.device, parsed.line);
          } else if (parsed.type === 'agent_list') {
            const isOnline = parsed.agents.some((a: any) => a.id === this.agentId);
            this.emit('status', isOnline ? 'Online' : 'Offline');
          }
        } catch (err) {
          console.error('Error parsing ws message:', err);
        }
      };

      this.ws.onclose = () => {
        console.log('🔌 CloudSocket: Connection closed');
        this.isConnecting = false;
        this.emit('status', 'Offline');
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('CloudSocket error:', err);
        this.isConnecting = false;
        this.scheduleReconnect();
      };
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (!this.active) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 5000);
  }

  public disconnect() {
    this.active = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.emit('status', 'Offline');
  }

  public sendCommand(command: string, payload: any = {}) {
    if (!this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Cannot send command: CloudSocket is not connected');
      return;
    }

    const envelope = {
      target: this.agentId,
      payload: {
        command,
        ...payload
      }
    };

    this.ws.send(JSON.stringify(envelope));
  }
}

export const cloudSocket = new CloudSocket();
