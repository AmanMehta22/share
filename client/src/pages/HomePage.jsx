import {
  Send,
  Download,
  ArrowRight,
  ShieldCheck,
  Zap,
  MonitorSmartphone,
  FolderSync,
  KeyRound,
  Server,
  WifiOff,
  Globe,
  Type,
} from 'lucide-react';

/**
 * Marketing + explanation homepage. Every claim here matches what the app
 * actually does: P2P bytes, signaling-only server, no accounts, no storage.
 */
export function HomePage({ onNavigate }) {
  return (
    <main id="main">
      {/* ------------------------------------------------------------ hero */}
      <section className="hero container">
        <span className="hero-eyebrow">
          <Zap size={14} aria-hidden="true" />
          Peer-to-peer · No account · No upload to cloud
        </span>
        <h1>Transfer files. Simply and directly.</h1>
        <p className="hero-sub">
          CodeShare moves files, folders or a block of plain text straight between two computers
          using a one-time code. Payload bytes never touch a server - only a tiny signaling service
          introduces the two browsers to each other.
        </p>

        <div className="hero-points">
          <span className="hero-point">
            <ShieldCheck size={16} aria-hidden="true" />
            Encrypted in transit (WebRTC DTLS)
          </span>
          <span className="hero-point">
            <FolderSync size={16} aria-hidden="true" />
            Folders keep their structure
          </span>
          <span className="hero-point">
            <MonitorSmartphone size={16} aria-hidden="true" />
            Works on desktop browsers
          </span>
        </div>

        <div
          className="grid-3"
          style={{ maxWidth: 860, margin: '40px auto 0', textAlign: 'left' }}
        >
          <button
            type="button"
            className="card card-action"
            onClick={() => onNavigate('send')}
          >
            <span className="card-icon">
              <Send size={22} aria-hidden="true" />
            </span>
            <h3>Send files</h3>
            <p className="muted small">
              Pick files or a folder, generate a code, and wait for the receiver to join and
              approve. Progress, speed and pause controls included.
            </p>
            <span className="row small" style={{ color: 'var(--accent-strong)', fontWeight: 650 }}>
              Start sending <ArrowRight size={15} aria-hidden="true" />
            </span>
          </button>

          <button
            type="button"
            className="card card-action"
            onClick={() => onNavigate('send-text')}
          >
            <span className="card-icon">
              <Type size={22} aria-hidden="true" />
            </span>
            <h3>Send text</h3>
            <p className="muted small">
              Paste a note, code snippet or log (up to 10 MB) and share a code. The receiver copies
              it with one click - nothing is uploaded anywhere.
            </p>
            <span className="row small" style={{ color: 'var(--accent-strong)', fontWeight: 650 }}>
              Start sending text <ArrowRight size={15} aria-hidden="true" />
            </span>
          </button>

          <button
            type="button"
            className="card card-action"
            onClick={() => onNavigate('receive')}
          >
            <span className="card-icon alt">
              <Download size={22} aria-hidden="true" />
            </span>
            <h3>Receive</h3>
            <p className="muted small">
              Enter the code from the sender, review exactly what is being shared, then accept -
              files save to disk, text appears ready to copy.
            </p>
            <span className="row small" style={{ color: '#6d28d9', fontWeight: 650 }}>
              Start receiving <ArrowRight size={15} aria-hidden="true" />
            </span>
          </button>
        </div>
      </section>

      {/* -------------------------------------------------- how it works */}
      <section className="section container">
        <div className="section-head">
          <h2>How it works</h2>
          <p>Three steps, no signup, works between any two computers you control.</p>
        </div>
        <div className="steps">
          <div className="step">
            <span className="step-num">1</span>
            <h3>Sender picks the payload</h3>
            <p>
              Choose a ZIP, several files or a whole folder - or switch to the text page and paste
              a message. CodeShare generates a short one-time code like{' '}
              <span className="mono">ABCD-EFGH-JKLM-NPQR</span>.
            </p>
          </div>
          <div className="step">
            <span className="step-num">2</span>
            <h3>Receiver joins with the code</h3>
            <p>
              The sender sees the join request and approves it. Both sides then connect directly,
              browser to browser, over WebRTC.
            </p>
          </div>
          <div className="step">
            <span className="step-num">3</span>
            <h3>Bytes flow peer-to-peer</h3>
            <p>
              The receiver confirms the file list before anything is sent. Chunks stream with real
              progress, pause and cancel - and success is only shown after verification.
            </p>
          </div>
        </div>
      </section>

      {/* -------------------------------------- connection & privacy */}
      <section className="section container">
        <div className="grid-2">
          <div className="panel panel-tint">
            <h3>
              <Server size={19} aria-hidden="true" />
              What the server ever sees
            </h3>
            <ul>
              <li>
                <strong>The transfer code</strong> - stored only as a SHA-256 hash, never in
                plain text, expiring after 15 minutes.
              </li>
              <li>
                <strong>Connection details (SDP/ICE)</strong> - the handshake data browsers need
                to find each other. Relayed, never stored.
              </li>
              <li>
                <strong>Nothing else.</strong> No file names, no file sizes, no progress, and
                above all no file bytes. Those travel directly between the two computers.
              </li>
            </ul>
          </div>

          <div className="panel">
            <h3>
              <WifiOff size={19} aria-hidden="true" />
              Honest limitations
            </h3>
            <ul>
              <li>
                <strong>Some networks block direct connections.</strong> Strict symmetric NATs,
                corporate firewalls or VPNs may prevent a P2P link. CodeShare uses free STUN
                only and has no TURN relay, so those cases fail with a clear error instead of
                silently routing your files through a third party.
              </li>
              <li>
                <strong>Both tabs must stay open</strong> for the whole transfer.
              </li>
              <li>
                <strong>Codes are single-use</strong> and valid for 15 minutes.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------- supported info */}
      <section className="section container">
        <div className="section-head">
          <h2>Good to know</h2>
        </div>
        <div className="grid-3">
          <div className="panel">
            <h3>
              <KeyRound size={18} aria-hidden="true" />
              No accounts, ever
            </h3>
            <p className="muted small">
              No email, phone number, password or OTP. The code is the only credential, and it
              dies with the session.
            </p>
          </div>
          <div className="panel">
            <h3>
              <FolderSync size={18} aria-hidden="true" />
              Folders and many files
            </h3>
            <p className="muted small">
              Folder structure is preserved. If the browser cannot write folders, the receiver
              can save everything as one ZIP - packed locally in the browser.
            </p>
          </div>
          <div className="panel">
            <h3>
              <Globe size={18} aria-hidden="true" />
              Runs anywhere you can host
            </h3>
            <p className="muted small">
              One Node process serves the site and the signaling channel. It fits inside free
              hosting tiers because it never stores file data.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- CTA */}
      <section className="section container center">
        <div className="card" style={{ padding: '40px 24px' }}>
          <h2>Ready? Pick a side.</h2>
          <p className="muted" style={{ margin: '10px auto 24px', maxWidth: '52ch' }}>
            Open CodeShare on both computers, send from one, receive on the other. The whole
            transfer stays between them.
          </p>
          <div className="btn-group" style={{ justifyContent: 'center' }}>
            <button type="button" className="btn btn-primary btn-lg" onClick={() => onNavigate('send')}>
              <Send size={18} aria-hidden="true" />
              Send files
            </button>
            <button type="button" className="btn btn-lg" onClick={() => onNavigate('send-text')}>
              <Type size={18} aria-hidden="true" />
              Send text
            </button>
            <button type="button" className="btn btn-lg" onClick={() => onNavigate('receive')}>
              <Download size={18} aria-hidden="true" />
              Receive files
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
