# PeerDrop Signaling Server

Node.js WebSocket signaling relay for PeerDrop. Runs on Render's free tier.

## Endpoints
- `GET /health` – JSON health check (`{"status":"ok","rooms":N,"peers":N,"uptime":N}`)
- `ws://host:PORT` – WebSocket connection point

## Message types

| Type | Direction | Description |
|------|-----------|-------------|
| `create-room` | Client → Server | Creates a new room, returns `room-created` |
| `join-room` | Client → Server | Joins existing room, returns `room-joined` |
| `offer` | Client → relay → Client | SDP offer |
| `answer` | Client → relay → Client | SDP answer |
| `ice-candidate` | Client → relay → Client | ICE candidate |
| `leave` | Client → Server | Leave room |
| `ping` | Client → Server | Keepalive, returns `pong` |

## Env vars
- `PORT` – listen port (default 3001)
- `ALLOWED_ORIGINS` – comma-separated origin allow-list (default: allow all)

## Deploy on Render
1. Push `/server` to a GitHub repo
2. Create a Render **Web Service**, type **Node**, build command `npm install`, start command `npm start`
3. Set `ALLOWED_ORIGINS` to `https://yourusername.github.io`
4. Copy the `wss://your-service.onrender.com` URL into `web/js/config.js`
