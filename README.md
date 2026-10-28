# CodeShare

**Free, code-based peer-to-peer file transfer. No accounts, no storage, no paid services.**

CodeShare moves files and folders directly between two computers. One side picks files and gets a
one-time code like `ABCD-EFGH-JKMN-PQRS`; the other side types that code, reviews the file list, and
accepts. The bytes then travel **browser to browser over WebRTC** — they are never uploaded to any
server.

- **₹0 / $0 cost** — no paid storage, no database, no TURN service, no domain, no API keys, no OTP
  emails or SMS. Nothing in this project can generate a charge.
- **Direct transfer** — file bytes go over an encrypted WebRTC `RTCDataChannel` between the two
  machines. The only server involved introduces the two browsers to each other (signaling) and never
  sees a single byte of file content.
- **Honest about limits** — some networks block direct connections. When that happens CodeShare says
  so clearly instead of silently routing your files through a third party.

---

## Table of contents

1. [Architecture](#architecture)
2. [How WebRTC transfer works](#how-webrtc-transfer-works)
3. [Why there is no cloud storage](#why-there-is-no-cloud-storage)
4. [Workflows](#workflows)
5. [Setup on Windows (PowerShell)](#setup-on-windows-powershell)
6. [Running the app](#running-the-app)
7. [Testing](#testing)
8. [Free hosting](#free-hosting)
9. [Browser compatibility](#browser-compatibility)
10. [STUN, NAT and TURN (read this if transfers fail)](#stun-nat-and-turn-read-this-if-transfers-fail)
11. [File size limits](#file-size-limits)
12. [Security model and limitations](#security-model-and-limitations)
13. [Configuration reference](#configuration-reference)
14. [Common errors](#common-errors)
15. [Hosting quotas and limits](#hosting-quotas-and-limits)
16. [What is tested automatically vs. manually](#what-is-tested-automatically-vs-manually)
17. [Cost confirmation](#cost-confirmation)

---

## Architecture

```
┌─────────────────────┐                         ┌─────────────────────┐
│  SENDER browser     │                         │ RECEIVER browser    │
│  (React + Vite)     │                         │ (React + Vite)      │
│                     │                         │                     │
│  · pick files/folder│                         │ · enter 16-char code│
│  · generate code    │                         │ · review file list  │
│  · approve receiver │                         │ · accept / reject   │
│  · chunk + send ─────┼──────┐   ┌─────────────┼── save to folder/ZIP│
│                     │      │   │             │                     │
└──────────┬──────────┘      │   │             └──────────┬──────────┘
           │ WebSocket       │   │  WebSocket             │
           │ (code, SDP,     │   │  (code, SDP,           │
           │  ICE only)      │   │   ICE only)            │
           ▼                 │   ▼                       │
┌──────────────────────────────────────────────┐          │
│  Signaling server (Node + Express +          │          │
│  Socket.IO) — one small process              │          │
│                                              │          │
│  · validates codes (SHA-256 hashed,          │          │
│    15-min TTL, single use)                   │          │
│  · relays SDP offers/answers + ICE candidates│          │
│  · strict 1:1 session membership             │          │
│  · rate limits + join-attempt caps           │          │
│                                              │          │
│  ✗ has NO route that accepts file uploads    │          │
│  ✗ no database, no filesystem storage        │          │
└──────────────────────────────────────────────┘          │
                                                          │
           ▲                                              │
           │ STUN (free, Google/Twilio):                  │
           │ "what is my public address?"                 │
           │                                              │
           │         WebRTC RTCDataChannel (DTLS-encrypted)│
           └──────────────────────────────────────────────┘
                 FILE BYTES travel ONLY on this arrow
```

**What crosses the server:** the transfer code (hashed on arrival), connection-handshake data
(SDP offers/answers, ICE candidates), and join/approve/cancel events.

**What never crosses the server:** file bytes, file names, file sizes, transfer progress. Those are
either computed in your browser or travel directly between the two computers.

Project layout:

```
codeshare/
├── client/          React + Vite frontend (src/, tests/)
│   ├── src/services/transfer/   transport-agnostic send/receive engines
│   ├── src/hooks/               sender & receiver state machines
│   └── src/utils/               code generation, ZIP writer, path safety
├── server/          Express + Socket.IO signaling server (src/, tests/)
└── package.json     npm workspaces root (dev / build / test / lint)
```

## How WebRTC transfer works

1. **Code generation (sender).** The browser draws 16 characters from a 31-symbol alphabet
   (A–Z minus I/L/O, plus digits 2–9) using the Web Crypto API with rejection sampling, formatted as
   4 groups: `XXXX-XXXX-XXXX-XXXX`. That is ~79 bits of entropy (requirement: ≥ 40). The alphabet
   excludes I, L, O, 0, 1 so codes can be read aloud without confusion.
2. **Signaling handshake.** The sender's browser asks the server to register the code (stored only
   as a SHA-256 hash). The receiver types the code; the server checks it, enforces single-use and
   1:1 membership, and tells the sender someone joined. The **sender must approve** before anything
   else happens.
3. **SDP offer/answer.** The sender creates an `RTCPeerConnection` with a data channel, produces an
   SDP offer; the receiver produces an SDP answer. Both are relayed through the signaling server,
   which validates and size-caps them but does not interpret them.
4. **ICE + STUN.** Each browser asks free public STUN servers what its public address looks like,
   gathers candidate network paths (host, server-reflexive), and trickles them through the server.
   The two browsers then race the candidates to find a direct route.
5. **Consent before bytes.** When the data channel opens, the sender sends a **manifest** (file
   names, paths, sizes). The receiver shows this list, and **no file is read from disk until the
   user clicks Accept**.
6. **Chunked binary transfer.** Files are sliced with `File.slice()` into 32 KiB binary frames
   (never Base64). Each frame is a 10-byte header (version, type, file index, chunk index) plus
   payload. The sender honours `bufferedAmount` backpressure (1 MiB high-water / 64 KiB low-water),
   so a large file never sits fully in memory. Chunks are ordered and size-checked; out-of-order or
   oversize data fails the transfer instead of corrupting output.
7. **Verification before "success".** The receiver validates every chunk index and byte count per
   file, then acks `transfer-complete`. Only after that ack does the sender show a success screen.
   A failed or cancelled transfer is rolled back — no partial file is kept.
8. **Saving.** The receiver chooses: **save into a folder** (File System Access API, streamed to
   disk chunk-by-chunk), **save as one ZIP** (packed locally in the browser by a built-in
   store-method ZIP writer), or **plain downloads** (single files). Folder structure and paths are
   preserved and sanitized against traversal.

## Why there is no cloud storage

Most file-transfer services work by **uploading your file to their storage**, giving you a link, and
having the recipient download it. That model requires (and bills for) storage + bandwidth, and it
means a third party holds your data.

CodeShare uses WebRTC data channels instead: the bytes go **directly between the two browsers**.
The server's only job is introductions — like exchanging phone numbers — which is a few kilobytes
of JSON per transfer. That is why the whole thing fits inside free hosting tiers and why there is
nothing to bill: **no file ever lands on a server, so no storage or transfer bandwidth is consumed
on hosting plans.** The trade-off is honest and important: if both peers cannot find a direct
network route (some NATs, CGNAT, corporate firewalls, VPNs), the transfer fails with a clear error
rather than falling back to a paid relay. See
[STUN, NAT and TURN](#stun-nat-and-turn-read-this-if-transfers-fail).

## Workflows

**Sender:** drag-drop files/folder (or browse) → validate → *Generate transfer code* → share the
code → approve the receiver when they join → watch real progress/speed/ETA → pause/resume/cancel
anytime → success only after the receiver's verified ack → *Send another transfer* without
refreshing.

**Receiver:** enter the code (normalization handles lowercase, spaces, dots, pasted messiness) →
wait for sender approval → review the incoming file list and total size → pick a save mode →
*Accept & receive* → real progress, pause/resume/cancel → files written by your own browser →
success/rollback screen → *Receive another transfer*.

Both sides detect disconnects, expired codes, rejects, and channel errors, and always end on an
explicit success / cancelled / failed screen — never a fake progress bar or a false "done".

## Setup on Windows (PowerShell)

Prerequisites: **Windows 10/11**, **Node.js 18+** (LTS recommended; this project is built and
tested on Node 24), **npm 9+**, and a code editor (VS Code). Check your versions:

```powershell
node --version    # v18 or newer
npm --version
```

Install Node from https://nodejs.org (LTS) if needed. Then, in PowerShell:

```powershell
# 1. Get the code
git clone https://github.com/AmanMehta22/share.git
cd share

# 2. Install all dependencies (workspaces: client + server, one command)
npm install

# 3. (Optional) configuration — the defaults work for local development
Copy-Item server\.env.example server\.env
Copy-Item client\.env.example client\.env
```

No API keys, tokens, or accounts are needed at any point.

## Running the app

**Development (both processes, one command)** — from the repo root `C:\Users\YOU\Desktop\share`:

```powershell
npm run dev
```

This starts:
- signaling server on **http://localhost:4000** (directory: `server\`, `node --watch src/server.js`)
- Vite dev server on **http://localhost:5173** (directory: `client\`), which proxies
  `/socket.io` to :4000 so the frontend needs zero configuration.

Open **http://localhost:5173** in two browser windows (or two computers — see below).

**Production-style (single process):**

```powershell
npm run build      # builds client/dist (Vite)
npm start          # starts the signaling server, which also serves client/dist (SERVE_CLIENT=1)
```

Then open **http://localhost:4000** — one port for the whole app.

Individual scripts (from the repo root):

| Command | What it does |
|---|---|
| `npm run dev` | server (:4000) + client (:5173) together, with auto-reload |
| `npm run dev:server` | signaling server only |
| `npm run dev:client` | Vite dev server only |
| `npm run build` | production build of the frontend into `client\dist` |
| `npm start` | signaling server (also serves `client\dist` when present) |
| `npm run lint` | ESLint for client + server |
| `npm test` | all automated tests (server + client) |

## Testing

### Automated tests (run here, on this machine)

```powershell
npm test
```

- **Server (85 tests):** code normalization/validation, SHA-256 hashing (never raw codes), session
  lifecycle (create → join → approve → active → close), 1:1 membership, duplicate receivers,
  sender-only approve/active, TTL expiry with ACTIVE-transfer exemption, sweeper + tombstones,
  per-IP join-attempt caps, and 26 **integration tests over real loopback sockets** exercising the
  full Socket.IO contract (acks, `peer:*` events, signal relay, malformed/oversized payload
  rejection, disconnect handling).
- **Client (108 tests):** code generation (entropy, rejection sampling, no excluded characters),
  path sanitization (traversal, NULs, reserved names, dedupe), the ZIP writer (CRC32 vectors,
  archive structure, round-trip bytes, unsafe-path rejection), the binary protocol (frame
  encode/decode, manifest validation, oversized/unknown frames), and the **transfer engines over a
  fake in-memory data channel**: happy paths, multi-file, directory entries, byte-for-byte
  integrity, binary-only frames, consent gating, reject, pause/resume, cancel from both sides,
  peer disconnect, out-of-order/size-mismatch detection, streaming folder writer with abort,
  backpressure, zero-byte files.

These verify everything that does not require two real browsers with real WebRTC.

### Manual two-computer test (required for full verification)

WebRTC peer connections need real browsers; that part is verified by hand:

**Two windows, one computer (quickest smoke test):**
1. `npm run dev`, open http://localhost:5173 in **two separate browser windows** (or one normal +
   one private window).
2. Window A → *Send files* → drop a ZIP and a folder → *Generate transfer code*.
3. Window B → *Receive files* → type the code → *Connect*.
4. Window A → *Approve & connect*. Window B → review the list → choose a save mode → *Accept*.
5. Verify: real progress on both sides, pause/resume works, and the received files match the
   originals (compare sizes/hashes). Try a >100 MB file to confirm backpressure and speed display.

**Two computers (LAN):** same steps; open `http://<sender-LAN-IP>:5173` (or :4000 in production
mode) on the receiver. Both machines must be able to reach the signaling server.

**Over the internet:** deploy once (see [Free hosting](#free-hosting)), then run the workflow from
two different networks (e.g. home + mobile hotspot). Mobile hotspots often use CGNAT — if the
connection cannot be established you will see an explicit connection-failed error after ~40 s;
that is the documented NAT limitation, not a bug.

**Also verify manually:** rejecting a transfer, cancelling mid-transfer on each side, closing a tab
mid-transfer (peer must show a disconnect error), code expiry after 15 minutes, reusing a spent
code (must fail), and folder-save on a Chromium browser (File System Access API) plus ZIP fallback
on Firefox/Safari.

## Free hosting

CodeShare needs **one small Node process** (signaling) plus **static files**. Both fit in free
tiers. The signaling server can serve the built frontend itself (`SERVE_CLIENT=1`, the default), so
a single free Node host runs everything.

**Option A — one free Node host (simplest).** Render, Railway, Fly.io, Glitch, and similar offer
free or hobby tiers that can run `npm start` with a Node build. Steps (example: Render):

1. Push this repo to GitHub (done: `https://github.com/AmanMehta22/share.git`).
2. Create a **Web Service** pointed at the repo.
3. Build command: `npm install && npm run build` · Start command: `npm start`.
4. Set env vars: `NODE_ENV=production`, `SERVE_CLIENT=1`, and `CLIENT_ORIGIN=https://your-app.onrender.com`
   (your app's own URL, so the browser may connect). Optional: `TRUST_PROXY=1` on hosts behind a
   proxy so rate limits key on the real client IP.
5. The app is served at the host's HTTPS URL — WebRTC works over HTTPS (and plain HTTP on
   localhost).

**Option B — split: static frontend + tiny signaling host.** Host `client/dist` on any free static
host (GitHub Pages, Netlify, Cloudflare Pages, Vercel) and run the signaling server on a free Node
host. Then set `VITE_SIGNALING_URL=https://your-signaling-host.example` at **build time**
(`$env:VITE_SIGNALING_URL="https://..."; npm run build`) and set that host's `CLIENT_ORIGIN` to the
static site's URL. The frontend uses hash routing (`#/home`, `#/send`, `#/receive`), so static hosts
need **no rewrite rules**.

**What these free tiers can and cannot do:** they are entirely sufficient because only signaling
traffic touches them (KB-scale JSON). Limits to expect are listed in
[Hosting quotas](#hosting-quotas-and-limits). **No paid upgrade is ever required by this codebase,
and none is silently enabled.**

## Browser compatibility

| Browser | Send/receive | Folder save | Folder pick |
|---|---|---|---|
| Chrome / Edge (desktop, current) | ✅ | ✅ (File System Access API) | ✅ |
| Firefox (desktop, current) | ✅ | ✅ (ZIP fallback) | ✅ |
| Safari (desktop 17+) | ✅ | ✅ (ZIP fallback) | partial |
| Mobile browsers | ⚠️ not recommended | varies | varies |

The ZIP fallback means every browser can complete a transfer; Chromium browsers additionally get
true folder-to-folder streaming. Both tabs must stay open for the whole transfer, on both sides.
Data channels require the page to be served from a secure context (HTTPS or localhost).

## STUN, NAT and TURN (read this if transfers fail)

Your router puts devices behind a **NAT** (private address inside, shared public address outside).
For two peers to connect directly, each must discover its public mapping and be reachable through
it. CodeShare asks free public **STUN** servers (Google, Twilio) for that mapping — STUN answers
the question "what does my address look like from outside?" and then steps aside; **no file data
ever passes through STUN**.

How direct the route is depends on both sides' NAT types:

| Sender ↔ Receiver NAT | Result with CodeShare |
|---|---|
| Both open / cone NATs (typical home routers) | ✅ connects directly |
| One symmetric NAT (some ISPs, CGNAT, mobile carriers) | ⚠️ often works via hole-punching, not guaranteed |
| Both symmetric / carrier-grade NAT | ❌ usually fails → clear error |
| Corporate firewalls, VPNs blocking UDP | ❌ may fail → clear error |

A **TURN relay** is the standard fallback: it forwards encrypted traffic when no direct route
exists. TURN consumes the relay's bandwidth, which is why commercial TURN is metered and billed.
**CodeShare deliberately includes no TURN server**, because "free TURN" cannot be guaranteed and a
hidden paid fallback would violate the zero-cost requirement. Instead, when no direct route is
found, the app reports the failure honestly and suggests practical remedies: try again (routes
vary), move one computer to a different network/hotspot, or enable UPnP/NAT-PMP or port forwarding
on the router.

## File size limits

There is **no application-imposed size limit** — chunking and backpressure mean memory use stays
bounded regardless of file size. Real limits come from elsewhere:

- **Browser memory:** the ZIP fallback and plain-download modes buffer files in browser memory; for
  very large transfers prefer **folder save** (streamed to disk). As a rule of thumb, keep
  ZIP-mode transfers under ~1–2 GB.
- **ZIP format cap:** a single ZIP cannot exceed 4 GB (format limit); folder save has no such cap.
- **The 15-minute code TTL applies only until the transfer starts.** Once the data channel is open,
  the session is marked ACTIVE and is exempt from expiry — a 10 GB transfer will not be killed at
  minute 15.
- **Path/manifest caps (hostile-input protection):** ≤ 100,000 entries, path length ≤ 1024
  characters, depth ≤ 32.

Practical guidance: multi-GB transfers work; expect them to be limited by the slower machine's disk
and by the network route, not by CodeShare.

## Security model and limitations

**Provided:**
- **Encryption in transit:** WebRTC data channels are always DTLS-encrypted (browser-enforced).
- **No content on servers:** the signaling server has no code path that accepts file bytes; file
  names/sizes/progress never pass through it.
- **Codes:** ≥ 79 bits of entropy from Web Crypto; single-use; 15-minute TTL; stored server-side
  only as SHA-256 hashes; logs reference sessions by hash prefix only.
- **Consent:** the sender approves the receiver, and the receiver sees the full file list and size
  before any byte is read from the sender's disk.
- **Server hardening:** strict 1:1 session membership, per-IP join-attempt caps and signal rate
  limits, payload validation and size caps on every signaling message, minimal security headers,
  CORS restricted to the configured client origin.
- **Receiver-side safety:** all incoming paths are sanitized (no `..`, absolute paths, drive
  letters, NULs, control characters, reserved device names); the ZIP writer re-validates every
  entry path as defense in depth.

**Limitations (be honest with users):**
- **No end-to-end identity verification.** The code proves control of the session, not the person's
  identity. Anyone who obtains a valid code *and* wins the race could join first — which is why the
  sender must approve and the receiver sees the file list.
- **Signaling metadata is visible to the server operator** while in transit: that a session exists,
  and the SDP/ICE handshake data (which includes network addresses — that is inherent to WebRTC
  connectivity checks). File contents and names are not.
- **No anonymity:** the server sees your IP address, as any web server does.
- **Session state is in-memory only.** A server restart drops active sessions (both peers are
  notified and must start over). Running multiple server instances breaks pairing without a shared
  store (e.g., Redis) — deliberately not added, to keep the project at ₹0.
- **Both tabs must stay open** for the duration of a transfer.
- **Not a substitute for professional secure-drop tooling** for high-threat models.

## Configuration reference

**Server — `server/.env`** (copy from `server\.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | HTTP port for signaling (+ static client if enabled) |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Comma-separated allowed browser origins (CORS + WebSocket) |
| `NODE_ENV` | `development` | `development` or `production` |
| `SESSION_TTL_MINUTES` | `15` | Minutes before an unused code expires |
| `MAX_JOIN_ATTEMPTS` | `5` | Failed joins per IP per code before that IP is blocked |
| `MAX_SESSIONS_PER_IP` | `10` | Live sessions one IP may hold |
| `MAX_SIGNALS_PER_MINUTE` | `600` | Signaling events per socket per minute |
| `TRUST_PROXY` | `0` | Set `1` only behind a reverse proxy (uses X-Forwarded-For for rate-limit keys) |
| `SERVE_CLIENT` | `1` | Serve `client/dist` from this server (single-host mode) |

**Client — `client/.env`** (copy from `client\.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `VITE_SIGNALING_URL` | *(empty = same origin)* | Signaling server URL, set at build time when frontend and server are hosted separately |

**No secrets belong anywhere in this project** — the frontend is public by definition, and the
server holds no credentials.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `Code not found` on join | Wrong/expired/spent code, or the sender closed the tab | Check the code; sender generates a new one |
| `Too many attempts` | Join-attempt cap triggered for your IP | Wait for the session to expire (≤ 15 min) and retry with the correct code |
| Stuck on `Connecting…`, then `Connection failed` | No direct network route (symmetric NAT/CGNAT/firewall/VPN) | See [STUN, NAT and TURN](#stun-nat-and-turn-read-this-if-transfers-fail) |
| `EADDRINUSE` on start | Port 4000 already in use | `netstat -ano | findstr :4000`, close that process, or set `PORT=4100` in `server/.env` |
| WebSocket errors in the console | `CLIENT_ORIGIN` doesn't match the page origin | Set `CLIENT_ORIGIN` to the exact scheme+host+port you browse (e.g. `http://localhost:5173`) |
| `code.split is not a function` / blank page after deploy | Frontend built with wrong `VITE_SIGNALING_URL` or served over HTTP | Rebuild with the right URL; serve over HTTPS |
| Browser blocks multiple downloads | Too many files in download mode | Use folder save or ZIP mode instead |
| Folder button missing | Browser lacks the File System Access API | Use ZIP or downloads mode (Firefox/Safari) |
| Transfer dies when a tab sleeps | Laptop sleep / tab suspension | Keep both machines awake; disable sleep during large transfers |
| `npm run dev` shows only one process | Old Node version | Use Node 18+ (`node --version`) |

## Hosting quotas and limits

Free tiers change over time; check the provider's current terms. Typical allowances and what
CodeShare does with them:

| Resource | Typical free allowance | CodeShare usage |
|---|---|---|
| Static hosting bandwidth (Pages/Netlify/Vercel) | 100 GB/month | Frontend assets only (~120 KB gzipped, cached) — effectively unlimited for personal use |
| Node host (Render/Railway/Fly/Glitch) | 100–500 hours/month, spins down when idle | A few KB per session; idle spin-down only adds seconds to the first connection |
| WebSocket connections | usually supported; idle timeouts 1–5 min | Socket.IO heartbeats keep them alive; transfers are typically done well within any timeout |
| RAM on free Node instances | 256–512 MB | Server holds only session metadata (KB per session, capped per IP) |

Nothing in the codebase depends on a paid tier, and there is **no code path that can start billing
you** — no third-party APIs, no metered relay, no storage service.

## What is tested automatically vs. manually

**Automatically verified by `npm test` (193 tests):**
code generation entropy & normalization; invalid/expired/unknown codes; duplicate receivers; session
TTL expiry (with ACTIVE exemption); sender approve/reject; signaling validation (all message types,
malformed and oversized payloads); unauthorized signaling; disconnect handling and cleanup; rate
limits and repeated invalid join attempts; binary frame codec; manifest validation; chunk ordering,
size verification and integrity; multi-file and zero-byte transfers; pause/resume/cancel from both
sides; consent gating; streaming writer with abort-on-cancel; backpressure; ZIP writer CRC and
structure; path traversal prevention.

**Requires manual two-computer testing (cannot be automated in Node):**
real browser-to-browser WebRTC connection across real NATs; actual DTLS encryption end-to-end;
true disk streaming via the File System Access API; drag-and-drop and folder-pick UX; clipboard
copy; browser download behavior; performance on real multi-GB files; and the honest NAT-limitation
error paths described above. The checklist is in [Testing](#manual-two-computer-test-required-for-full-verification).

**Not done and not claimed:** this project has no browser-E2E suite (no Playwright/Selenium) and
has not been deployed to any hosting provider as part of its development — the hosting steps above
are documented instructions, not a report of a completed deployment.

## Cost confirmation

This project uses **no paid storage, no database, no TURN relay, no domain, no API, no email/SMS
service, and no subscription of any kind**. All dependencies are open-source and free
(React, Vite, Express, Socket.IO, Vitest, ESLint, lucide-react). The only infrastructure it ever
touches is whatever free hosting you choose for a small Node process and static files — and file
bytes never touch that infrastructure at all. **Nothing in this codebase can incur a charge.**

## License

MIT
