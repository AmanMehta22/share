import { useCallback, useEffect, useState } from 'react';
import { Navbar } from './components/Navbar.jsx';
import { Footer } from './components/Footer.jsx';
import { HomePage } from './pages/HomePage.jsx';
import { SendPage } from './pages/SendPage.jsx';
import { SendTextPage } from './pages/SendTextPage.jsx';
import { ReceivePage } from './pages/ReceivePage.jsx';

const VALID_VIEWS = new Set(['home', 'send', 'send-text', 'receive']);

function viewFromHash() {
  const raw = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  return VALID_VIEWS.has(raw) ? raw : 'home';
}

/**
 * Tiny hash-router shell: /#/home, /#/send, /#/send-text, /#/receive.
 * Hash routing means the static build works on any free host without
 * server-side rewrite rules.
 */
export function App() {
  const [view, setView] = useState(viewFromHash);

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next) => {
    if (!VALID_VIEWS.has(next)) return;
    window.location.hash = `/${next}`;
    setView(next);
    // Move focus to the main region for keyboard/screen-reader users.
    requestAnimationFrame(() => {
      document.getElementById('main')?.focus?.();
    });
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Navbar view={view} onNavigate={navigate} />
      {view === 'home' && <HomePage onNavigate={navigate} />}
      {view === 'send' && <SendPage onNavigate={navigate} />}
      {view === 'send-text' && <SendTextPage onNavigate={navigate} />}
      {view === 'receive' && <ReceivePage onNavigate={navigate} />}
      <Footer />
    </>
  );
}
