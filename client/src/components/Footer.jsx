import { ShieldCheck, Wifi, FolderSync, Code2 } from 'lucide-react';

/** Project information footer - no analytics, no third-party embeds. */
export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="stack stack-3">
            <div className="row">
              <span className="brand-mark" aria-hidden="true">
                <Wifi size={17} strokeWidth={2.4} />
              </span>
              <strong style={{ fontSize: '1.05rem' }}>CodeShare</strong>
            </div>
            <p>
              Transfer files between computers using a unique code. File bytes travel directly over
              WebRTC; a small signaling server only introduces the two browsers to each other.
            </p>
          </div>

          <div>
            <h4>How it works</h4>
            <ul>
              <li>
                <ShieldCheck size={14} style={{ display: 'inline', marginRight: 6 }} aria-hidden="true" />
                WebRTC DTLS encryption in transit
              </li>
              <li>
                <FolderSync size={14} style={{ display: 'inline', marginRight: 6 }} aria-hidden="true" />
                Files and folders, structure preserved
              </li>
              <li>No account, phone number or email</li>
              <li>No storage, database or tracking</li>
            </ul>
          </div>

          <div>
            <h4>Project</h4>
            <ul>
              <li>React + Vite frontend</li>
              <li>Node.js + Express + Socket.IO signaling</li>
              <li>Runs fully on your own machine</li>
              <li>MIT licensed · zero paid services</li>
            </ul>
          </div>
        </div>

        <div className="footer-bottom">
          <span>
            CodeShare is a self-hosted demo project. It does not claim perfect anonymity or
            end-to-end identity verification.
          </span>
          <span className="row" style={{ gap: 6 }}>
            <Code2 size={14} aria-hidden="true" />
            Built for a ₹0 budget
          </span>
        </div>
      </div>
    </footer>
  );
}
