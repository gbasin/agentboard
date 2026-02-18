# Speech-to-Text Implementation Plan

> Technical specification for adding voice input to Agentboard

## Overview

Add speech-to-text functionality to enable voice input for agent chat. User speaks, text appears in chat input to send to agents.

### Goals

- Enable voice-to-text input with partial (draft) and final transcription
- Phrase-level latency: 1-3 seconds acceptable
- Support iOS Safari 16.4+ and desktop Safari/Chrome
- Self-hosted solution (no cloud API costs)
- Keep audio local; no persistence

### Non-Goals (v1)

- Custom vocabulary/hotwords (terms like "kubectl", "tmux")
- Multi-language support (English only)
- Word-by-word streaming
- Concurrent sessions (single user)

---

## Architecture

### Why This Design

1. **Parakeet TDT 0.6B v2** - Best accuracy (6.05% WER on Open ASR Leaderboard)
2. **MLX on Apple Silicon** - Native Mac performance via senstella/parakeet-mlx
3. **Web Audio API + AudioWorklet** - Reliable cross-browser PCM capture (avoids MediaRecorder + ffmpeg decode issues)
4. **Bun proxy** - Single network entry point solves iOS HTTPS/WSS requirements

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser (iOS Safari 16.4+ / Desktop Safari / Chrome)                   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  MicButton Component                                             │   │
│  │  └─► useSpeechToText Hook                                       │   │
│  │       └─► AudioWorklet (capture + resample to 16kHz mono)       │   │
│  │            └─► WebSocket binary frames (PCM int16 LE)           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                              │ WSS (same origin)                        │
│                              ▼                                          │
└─────────────────────────────────────────────────────────────────────────┘
                               │
                               │ wss://hostname:3000/api/stt/transcribe
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Bun/Hono Server (port 3000)                                            │
│                                                                         │
│  Existing routes: /api/sessions, /api/ws, etc.                         │
│                                                                         │
│  NEW: /api/stt/transcribe (WebSocket)                                  │
│       └─► Proxy to ws://127.0.0.1:8765/ws/transcribe                   │
│                                                                         │
│  NEW: /api/stt/health                                                  │
│       └─► Proxy to http://127.0.0.1:8765/health                        │
└─────────────────────────────────────────────────────────────────────────┘
                               │
                               │ ws://127.0.0.1:8765 (localhost only)
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Python FastAPI Sidecar (127.0.0.1:8765)                               │
│                                                                         │
│  Endpoints:                                                             │
│  - GET /health → { status, modelLoaded, version }                      │
│  - WS /ws/transcribe → streaming transcription                         │
│                                                                         │
│  Processing:                                                            │
│  1. Receive binary PCM frames (int16 LE, 16kHz, mono)                  │
│  2. Convert int16 → float32 (parakeet-mlx expects float32)             │
│  3. Buffer ~0.5-1.5s of audio before calling add_audio()               │
│  4. Return partial/final transcription JSON                            │
│                                                                         │
│  Model: mlx-community/parakeet-tdt-0.6b-v2 (~2GB memory)               │
│  Runtime: senstella/parakeet-mlx                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why Bun Proxy?

iOS Safari cannot access `localhost` from a device. It requires:
- Real hostname/IP (e.g., `mac.local` or `192.168.x.x`)
- HTTPS for microphone access
- WSS for WebSocket over HTTPS

By proxying through Bun:
- Browser connects to same origin (no CORS issues)
- Single HTTPS/WSS endpoint
- Python sidecar stays on localhost (secure, not exposed to LAN)

---

## Component Design

### Browser Components

#### 1. AudioWorklet Processor (`stt-processor.worklet.ts`)

Runs in audio thread for low-latency capture.

```typescript
// Registered as 'stt-processor'
class STTProcessor extends AudioWorkletProcessor {
  // Captures audio, resamples to 16kHz, outputs int16 LE
  // Sends to main thread via port.postMessage()
}
```

**Responsibilities:**
- Capture raw audio from microphone
- Resample from device sample rate (44.1kHz/48kHz) to 16kHz
- Convert float32 samples to int16 LE
- Buffer into frames (~100ms each)
- Post frames to main thread

**Fallback:** ScriptProcessorNode if AudioWorklet unavailable (older browsers)

#### 2. useSpeechToText Hook (`useSpeechToText.ts`)

State machine managing the full lifecycle.

```typescript
interface STTState {
  status: 'idle' | 'connecting' | 'recording' | 'stopping' | 'error'
  isSupported: boolean
  finalizedText: string
  draftText: string
  error: string | null
  modelLoading: boolean
  modelProgress: number // 0-100
}

interface STTActions {
  startRecording: () => Promise<void>
  stopRecording: () => void
  cancelRecording: () => void
}
```

**State Transitions:**
```
idle ──[start]──► connecting ──[ws open]──► recording ──[stop]──► stopping ──[final]──► idle
  │                    │                        │                      │
  │                    └──[error]───────────────┴──────────────────────┴──► error ──[reset]──► idle
```

**Responsibilities:**
- Manage AudioContext lifecycle (handle iOS suspend/resume)
- Create and connect AudioWorklet
- Manage WebSocket connection
- Parse incoming JSON messages
- Handle errors and cleanup

#### 3. MicButton Component (`MicButton.tsx`)

Visual component with states.

```typescript
interface MicButtonProps {
  onTranscript: (text: string) => void
  disabled?: boolean
  className?: string
}
```

**Visual States:**
| State | Appearance |
|-------|------------|
| Idle | Gray mic icon |
| Connecting | Gray mic, spinner |
| Recording | Red pulsing mic |
| Model Loading | Gray mic, progress % |
| Error | Red mic, error tooltip |
| Unsupported | Hidden or disabled with tooltip |

**Live Preview:**
While recording, show overlay above button:
- Finalized text in white
- Draft text in gray italic

### Server Components

#### 4. WebSocket Proxy (Hono routes)

Add to `src/server/index.ts`:

```typescript
// Health check proxy
app.get('/api/stt/health', async (c) => {
  const res = await fetch('http://127.0.0.1:8765/health')
  return c.json(await res.json())
})

// WebSocket proxy
app.get('/api/stt/transcribe', upgradeWebSocket((c) => ({
  onOpen(event, ws) {
    // Connect to Python sidecar
    // Bidirectional proxy
  }
})))
```

#### 5. Python FastAPI Sidecar (`stt/server.py`)

```python
from fastapi import FastAPI, WebSocket
from parakeet_mlx import from_pretrained
import numpy as np

app = FastAPI()
model = None

@app.on_event("startup")
async def load_model():
    global model
    model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v2")

@app.get("/health")
async def health():
    return {"status": "ok", "modelLoaded": model is not None, "version": "1.0.0"}

@app.websocket("/ws/transcribe")
async def transcribe(websocket: WebSocket):
    await websocket.accept()

    audio_buffer = []
    buffer_duration = 0.0
    TARGET_BUFFER_SECONDS = 1.0

    with model.transcribe_stream(context_size=(256, 256)) as transcriber:
        while True:
            message = await websocket.receive()

            if message["type"] == "websocket.receive":
                if "bytes" in message:
                    # Convert int16 LE to float32
                    pcm_int16 = np.frombuffer(message["bytes"], dtype=np.int16)
                    pcm_float32 = pcm_int16.astype(np.float32) / 32768.0

                    audio_buffer.append(pcm_float32)
                    buffer_duration += len(pcm_float32) / 16000.0

                    # Feed to model when buffer is full
                    if buffer_duration >= TARGET_BUFFER_SECONDS:
                        chunk = np.concatenate(audio_buffer)
                        transcriber.add_audio(chunk)
                        audio_buffer = []
                        buffer_duration = 0.0

                        await websocket.send_json({
                            "type": "partial",
                            "finalized": transcriber.finalized_tokens,
                            "draft": transcriber.draft_tokens
                        })

                elif "text" in message:
                    data = json.loads(message["text"])
                    if data["type"] == "stop":
                        # Flush remaining buffer
                        if audio_buffer:
                            chunk = np.concatenate(audio_buffer)
                            transcriber.add_audio(chunk)

                        await websocket.send_json({
                            "type": "final",
                            "text": transcriber.result
                        })
                        break
```

---

## WebSocket Protocol

### URL

```
wss://{host}:{port}/api/stt/transcribe?v=1
```

### Message Flow

```
CLIENT                                          SERVER
  │                                                │
  │──── { type: "config", ... } ──────────────────►│
  │                                                │
  │◄─── { type: "ack", maxFrameBytes, ... } ──────│
  │                                                │
  │──── { type: "start", utteranceId } ───────────►│
  │                                                │
  │──── [binary PCM frame] ───────────────────────►│
  │──── [binary PCM frame] ───────────────────────►│
  │◄─── { type: "partial", finalized, draft } ────│
  │──── [binary PCM frame] ───────────────────────►│
  │──── [binary PCM frame] ───────────────────────►│
  │◄─── { type: "partial", finalized, draft } ────│
  │                                                │
  │──── { type: "stop", utteranceId } ────────────►│
  │                                                │
  │◄─── { type: "final", text } ──────────────────│
  │                                                │
  └────────────── [connection closed] ─────────────┘
```

### Client → Server Messages

#### Config (JSON, first message)
```json
{
  "type": "config",
  "protocolVersion": 1,
  "sessionId": "uuid",
  "audio": {
    "format": "pcm_s16le",
    "sampleRate": 16000,
    "channels": 1
  }
}
```

#### Start (JSON)
```json
{
  "type": "start",
  "utteranceId": "uuid"
}
```

#### Audio (Binary)
- Raw PCM: signed 16-bit little-endian, mono, 16kHz
- Frame size: 50-200ms recommended (~1600-6400 bytes per frame)

#### Stop (JSON)
```json
{
  "type": "stop",
  "utteranceId": "uuid"
}
```

#### Cancel (JSON)
```json
{
  "type": "cancel",
  "utteranceId": "uuid"
}
```

### Server → Client Messages

#### Ack (JSON)
```json
{
  "type": "ack",
  "sessionId": "uuid",
  "maxFrameBytes": 32768,
  "maxSessionSeconds": 300
}
```

#### Partial (JSON)
```json
{
  "type": "partial",
  "utteranceId": "uuid",
  "finalized": "hello world",
  "draft": " this is",
  "seq": 5
}
```

#### Final (JSON)
```json
{
  "type": "final",
  "utteranceId": "uuid",
  "text": "hello world this is a test"
}
```

#### Error (JSON)
```json
{
  "type": "error",
  "code": "MAX_DURATION_EXCEEDED",
  "message": "Recording exceeded maximum duration of 300 seconds",
  "retryable": false
}
```

### Error Codes

| Code | Description | Retryable |
|------|-------------|-----------|
| `INVALID_CONFIG` | Malformed config message | No |
| `UNSUPPORTED_FORMAT` | Audio format not supported | No |
| `MAX_FRAME_EXCEEDED` | Single frame too large | No |
| `MAX_DURATION_EXCEEDED` | Recording too long | No |
| `IDLE_TIMEOUT` | No audio received for too long | Yes |
| `SERVER_BUSY` | Another session active | Yes |
| `MODEL_UNAVAILABLE` | Model failed to load | No |
| `INTERNAL_ERROR` | Unexpected server error | Yes |

---

## File Structure

### New Files

```
agentboard/
├── stt/
│   ├── requirements.txt          # Python dependencies
│   ├── server.py                 # FastAPI WebSocket server
│   └── README.md                 # Sidecar documentation
├── src/
│   ├── client/
│   │   ├── components/
│   │   │   └── MicButton.tsx     # Mic button component
│   │   ├── hooks/
│   │   │   └── useSpeechToText.ts # STT hook
│   │   └── workers/
│   │       └── stt-processor.worklet.ts # AudioWorklet
│   └── server/
│       └── sttProxy.ts           # WebSocket proxy routes
└── docs/
    └── stt-implementation-plan.md # This file
```

### Modified Files

| File | Changes |
|------|---------|
| `src/server/index.ts` | Import and mount STT proxy routes |
| `src/client/components/TerminalControls.tsx` | Add MicButton (mobile) |
| `src/client/components/Terminal.tsx` | Add floating MicButton (desktop) |
| `package.json` | Add `dev:stt` script, concurrently config |
| `vite.config.ts` | Configure worker bundling for AudioWorklet |

---

## UI Placement

### Mobile (TerminalControls.tsx)

Add mic button next to paste button in the bottom control strip:

```
┌─────────────────────────────────────────────────────────────────┐
│ [ctrl] [esc] [tab] [1] [2] [3] [←] [↑] [↓] [→] [⌫]            │
│ [enter]                              [paste] [🎤]              │
└─────────────────────────────────────────────────────────────────┘
```

### Desktop (Terminal.tsx)

Add floating mic button in bottom-right corner, similar to scroll-to-bottom button:

```
┌─────────────────────────────────────────────────────────────────┐
│  Terminal content                                               │
│                                                                 │
│                                                                 │
│                                                                 │
│                                                         [↓] [🎤]│
└─────────────────────────────────────────────────────────────────┘
```

### Recording State UI

While recording, show live transcription preview:

```
                    ┌─────────────────────────────┐
                    │ Hello world [this is a]     │  ← finalized + draft
                    └─────────────────────────────┘
                              [🎤 recording...]
```

---

## iOS Safari Considerations

### AudioContext User Gesture Requirement

iOS requires user interaction to start AudioContext:

```typescript
const startRecording = async () => {
  // Must be called from user gesture (click/tap)
  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }
  // ... start recording
}
```

### AudioContext Interruptions

iOS suspends AudioContext on:
- Incoming phone calls
- Siri activation
- Control Center audio controls
- App backgrounding

Handle `statechange` event:

```typescript
audioContext.onstatechange = () => {
  if (audioContext.state === 'interrupted' || audioContext.state === 'suspended') {
    // Stop recording, notify user
    stopRecording()
    setError('Recording interrupted')
  }
}
```

### AudioWorklet Module Loading

Safari requires careful timing for AudioWorklet module registration:

```typescript
// Must wait for audioContext to be running
await audioContext.audioWorklet.addModule('/workers/stt-processor.worklet.js')
```

### MIME Type (Not Applicable)

Since we're using Web Audio API with raw PCM (not MediaRecorder), MIME type detection is not needed. This simplifies iOS compatibility significantly.

---

## Security

### Network Binding

- **Python sidecar**: Binds to `127.0.0.1:8765` only (not `0.0.0.0`)
- **Bun server**: Handles all external connections
- **No direct access** to Python from network

### Origin Validation

Bun proxy should validate Origin header:

```typescript
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://mac.local:3000',
  // Add configured hostname
]
```

### Session Limits

| Limit | Value | Enforced By |
|-------|-------|-------------|
| Max frame size | 32KB | Server |
| Max session duration | 5 minutes | Server |
| Max total bytes | 12MB | Server |
| Idle timeout | 30 seconds | Server |
| Concurrent sessions | 1 | Server |

### Authentication (Future)

For v1, no authentication (trusted local network). Future options:
- Per-run random token generated at startup
- Share auth with main Agentboard session

---

## Error Handling

### Client-Side

| Error | User Experience |
|-------|-----------------|
| Mic permission denied | Show error message, disable mic button |
| WebSocket failed to connect | Retry 3x with backoff, show error |
| WebSocket disconnected mid-recording | Save finalized text, show error |
| AudioContext suspended | Stop recording, show "interrupted" message |
| Server busy | Show "Another session active" message |
| Model not loaded | Show "Loading model..." with progress |

### Server-Side

| Error | Response |
|-------|----------|
| Invalid config | Send error JSON, close connection (1008) |
| Frame too large | Send error JSON, close connection (1008) |
| Duration exceeded | Send error JSON with final text, close (1000) |
| Model inference error | Send error JSON, close connection (1011) |

### Graceful Degradation

| Condition | Behavior |
|-----------|----------|
| AudioWorklet unsupported | Fall back to ScriptProcessorNode |
| ScriptProcessorNode unsupported | Hide mic button |
| Non-Apple-Silicon Mac | Show "Requires Apple Silicon" message |
| Python sidecar not running | Show "STT unavailable" on mic click |

---

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Time to first partial | < 1.5s | After first audio chunk received |
| Final result latency | < 700ms | After stop signal |
| Model cold start | < 10s | First load after server start |
| Memory usage | < 3GB | Python sidecar process |
| Audio latency | < 100ms | Capture to WebSocket send |

### Chunk Buffering Strategy

Browser sends small frames (~100ms) for low latency, server buffers to ~1s before calling model:

```
Browser: [100ms][100ms][100ms][100ms][100ms][100ms][100ms][100ms][100ms][100ms]
            │      │      │      │      │      │      │      │      │      │
Server:     └──────┴──────┴──────┴──────┴──────┘      └──────┴──────┴──────┴──────┘
                         │                                        │
                    [~500ms buffer]                          [~500ms buffer]
                         │                                        │
                         ▼                                        ▼
                   add_audio()                              add_audio()
                         │                                        │
                         ▼                                        ▼
                   partial result                           partial result
```

---

## Testing Strategy

### Unit Tests

| Component | Tests |
|-----------|-------|
| `useSpeechToText` | State transitions, error handling, cleanup |
| `MicButton` | Render states, click handlers, accessibility |
| `stt-processor.worklet` | Resampling accuracy, frame sizing |
| `server.py` | Message parsing, buffer management, int16→float32 |

### Integration Tests

| Test | Method |
|------|--------|
| End-to-end transcription | Send fixture PCM file via WebSocket, verify output |
| WebSocket proxy | Verify Bun correctly proxies to Python sidecar |
| Error handling | Trigger each error condition, verify client response |

### Manual Testing

| Browser | Device | Tests |
|---------|--------|-------|
| Safari | iPhone (iOS 16.4+) | Mic permission, recording, interruptions |
| Safari | iPad | Same as iPhone |
| Safari | macOS | Recording, accuracy |
| Chrome | macOS | Recording, accuracy |
| Chrome | Windows | (if supported in future) |

### Test Audio Fixtures

Create test audio files:
- `test-short.pcm` - 3 seconds, clear speech
- `test-noise.pcm` - Speech with background noise
- `test-long.pcm` - 60 seconds, continuous speech

---

## Deployment

### Development

```bash
# Start all services
bun run dev

# Or manually:
bun run dev:frontend &
bun run dev:backend &
bun run dev:stt &
```

### package.json Scripts

```json
{
  "scripts": {
    "dev": "concurrently \"bun run dev:frontend\" \"bun run dev:backend\" \"bun run dev:stt\"",
    "dev:frontend": "vite",
    "dev:backend": "bun run --watch src/server/index.ts",
    "dev:stt": "cd stt && python -m uvicorn server:app --host 127.0.0.1 --port 8765 --reload",
    "stt:install": "cd stt && pip install -r requirements.txt"
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STT_ENABLED` | `true` | Enable/disable STT feature |
| `STT_HOST` | `127.0.0.1` | Python sidecar bind host |
| `STT_PORT` | `8765` | Python sidecar port |
| `STT_MAX_SECONDS` | `300` | Max recording duration |
| `STT_LOG_LEVEL` | `INFO` | Python logging level |

### Health Check

```bash
# Check if sidecar is running
curl http://127.0.0.1:8765/health
# {"status":"ok","modelLoaded":true,"version":"1.0.0"}
```

---

## Implementation Order

### Phase 1: Python Sidecar (2-3 hours)

1. Create `stt/requirements.txt`
2. Create `stt/server.py` with:
   - Health endpoint
   - WebSocket endpoint
   - Model loading
   - int16 → float32 conversion
   - Buffering logic
3. Test standalone with audio file

### Phase 2: Bun Proxy (1-2 hours)

1. Create `src/server/sttProxy.ts`
2. Add routes to `src/server/index.ts`
3. Test proxy with curl/wscat

### Phase 3: AudioWorklet (2-3 hours)

1. Create `stt-processor.worklet.ts`
2. Configure Vite for worker bundling
3. Test resampling accuracy

### Phase 4: React Hook (2-3 hours)

1. Create `useSpeechToText.ts`
2. Implement state machine
3. Handle AudioContext lifecycle
4. Handle iOS interruptions

### Phase 5: UI Components (2-3 hours)

1. Create `MicButton.tsx`
2. Add to `TerminalControls.tsx` (mobile)
3. Add to `Terminal.tsx` (desktop)
4. Style recording states

### Phase 6: Integration & Testing (2-3 hours)

1. End-to-end testing
2. iOS Safari testing on device
3. Error handling verification
4. Performance tuning

**Total Estimated Time: 12-18 hours**

---

## Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| MediaRecorder vs Web Audio? | Web Audio + AudioWorklet (avoids ffmpeg decode issues) |
| How to handle iOS localhost? | Proxy through Bun server |
| Chunk size for parakeet-mlx? | Send small frames, buffer to ~1s on server |
| Audio format for model? | float32 (convert from int16 on server) |
| Sample rate? | 16kHz mono (Parakeet requirement) |

## Future Enhancements

- **Custom vocabulary** - Hotwords for technical terms (requires different model or post-processing)
- **VAD-based auto-stop** - Automatically stop on silence
- **Multi-language** - Support additional languages
- **Concurrent sessions** - Queue or reject additional sessions
- **Model prewarming** - Download/load model at app startup
- **Waveform visualization** - Show audio levels while recording
