import { ArrowLeftRight, Send, Download, Home, Type } from 'lucide-react';

/**
 * Top navigation. The logo always returns to the homepage; the actions
 * mirror the product's whole workflow (send files / send text / receive).
 */
export function Navbar({ view, onNavigate }) {
  return (
    <header className="navbar">
      <div className="container navbar-inner">
        <button
          type="button"
          className="brand"
          onClick={() => onNavigate('home')}
          aria-label="CodeShare home"
        >
          <span className="brand-mark" aria-hidden="true">
            <ArrowLeftRight size={18} strokeWidth={2.4} />
          </span>
          CodeShare
          <span className="brand-badge">P2P</span>
        </button>

        <nav className="nav-actions" aria-label="Primary">
          {view !== 'home' && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate('home')}>
              <Home size={15} aria-hidden="true" />
              <span className="label">Home</span>
            </button>
          )}
          <button
            type="button"
            className={`btn btn-sm ${view === 'send' ? 'btn-primary' : ''}`}
            onClick={() => onNavigate('send')}
            aria-current={view === 'send' ? 'page' : undefined}
          >
            <Send size={15} aria-hidden="true" />
            <span className="label">Send</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm ${view === 'send-text' ? 'btn-primary' : ''}`}
            onClick={() => onNavigate('send-text')}
            aria-current={view === 'send-text' ? 'page' : undefined}
          >
            <Type size={15} aria-hidden="true" />
            <span className="label">Text</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm ${view === 'receive' ? 'btn-primary' : ''}`}
            onClick={() => onNavigate('receive')}
            aria-current={view === 'receive' ? 'page' : undefined}
          >
            <Download size={15} aria-hidden="true" />
            <span className="label">Receive</span>
          </button>
        </nav>
      </div>
    </header>
  );
}
