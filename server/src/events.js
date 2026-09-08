// Tiny in-process event bus + Server-Sent Events hub. Every browser tab keeps one EventSource
// open and receives job progress, GPU state and queue updates without polling.
import { EventEmitter } from "node:events";

export class Events extends EventEmitter {
  constructor() { super(); this.setMaxListeners(200); this.clients = new Set(); }
  /** Broadcast to all SSE clients and to in-process listeners. */
  emitAll(type, data) {
    this.emit(type, data);
    const line = `event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    for (const res of this.clients) { try { res.write(line); } catch { this.clients.delete(res); } }
  }
  /** Express handler for GET /api/events */
  handler() {
    return (req, res) => {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      res.write(`retry: 3000\nevent: hello\ndata: {}\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
      req.on("close", () => { clearInterval(ping); this.clients.delete(res); });
    };
  }
}
