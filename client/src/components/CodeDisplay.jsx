import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';

const COPY_RESET_MS = 2000;

/**
 * Renders the transfer code as large monospace groups with a copy button.
 * The whole code is one selectable string for easy manual copying too.
 */
export function CodeDisplay({ code }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const resetTimer = useRef(null);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const handleCopy = useCallback(async () => {
    if (!code) return;
    setCopyFailed(false);
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      // Fallback for non-secure contexts / older browsers.
      try {
        const textarea = document.createElement('textarea');
        textarea.value = code;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        ok = document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch {
        ok = false;
      }
    }
    setCopied(ok);
    setCopyFailed(!ok);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), COPY_RESET_MS);
  }, [code]);

  if (!code) return null;
  const groups = code.split('-');

  return (
    <div className="stack stack-2" style={{ alignItems: 'center' }}>
      <div className="code-box" aria-label={`Transfer code: ${code}`}>
        {groups.map((group, index) => (
          <span key={index} className={`code-seg ${index === 0 ? 'highlight' : ''}`}>
            {group}
          </span>
        ))}
      </div>

      <button type="button" className="btn" onClick={handleCopy}>
        {copied ? (
          <>
            <Check size={16} aria-hidden="true" />
            Copied
          </>
        ) : (
          <>
            <Copy size={16} aria-hidden="true" />
            Copy code
          </>
        )}
      </button>

      <p className="copy-note" role="status" aria-live="polite">
        {copied && 'Code copied to clipboard.'}
        {copyFailed && 'Could not copy automatically - select the code and copy it manually.'}
      </p>
    </div>
  );
}
