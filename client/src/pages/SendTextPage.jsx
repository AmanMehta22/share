import { useEffect, useMemo, useState } from 'react';
import { Copy, Type } from 'lucide-react';
import { useSenderFlow, SENDER_PHASE, SEND_MODE } from '../hooks/useSenderFlow.js';
import { LIMITS } from '../config.js';
import { FlowSteps } from '../components/FlowSteps.jsx';
import { ModePicker } from '../components/ModePicker.jsx';
import { SendScreens } from '../components/SendScreens.jsx';
import { STEPS, stepForPhase } from '../utils/sendSteps.js';
import { formatBytes } from '../utils/format.js';
import { Alert } from '../components/Alert.jsx';
import { Spinner } from '../components/Spinner.jsx';

const MAX_TEXT_LABEL = formatBytes(LIMITS.maxTextBytes);

/**
 * Send a plain-text message with the same code -> approve -> WebRTC flow as
 * files. The payload is one flagged manifest entry; the receiver shows it
 * on screen with a copy button instead of writing it to disk.
 */
export function SendTextPage({ onNavigate }) {
  const flow = useSenderFlow();
  const { phase, mode, groupSize, selectionError, error } = flow;
  const busy = phase === SENDER_PHASE.GENERATING;
  const isGroup = mode === SEND_MODE.GROUP;

  const [text, setText] = useState('');
  // Exact UTF-8 byte count, debounced so a huge paste does not re-encode on
  // every keystroke. The cap itself is enforced synchronously on generate.
  const [byteLength, setByteLength] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setByteLength(text.length === 0 ? 0 : new TextEncoder().encode(text).length);
    }, 120);
    return () => clearTimeout(timer);
  }, [text]);

  const overLimit = byteLength > LIMITS.maxTextBytes;
  const canGenerate = text.length > 0 && !overLimit && !busy;

  const charactersLabel = useMemo(() => text.length.toLocaleString(), [text.length]);

  const handleGenerate = async () => {
    const selection = flow.setTextSelection(text);
    if (!selection) return;
    await flow.generateCode();
  };

  // ------------------------------------------------------------ idle / select
  if (phase === SENDER_PHASE.IDLE || busy) {
    return (
      <main id="main" className="flow container">
        <FlowSteps steps={STEPS} current={stepForPhase(phase)} />
        <div className="card flow-card stack stack-5">
          <div className="flow-title">
            <span className="card-icon" aria-hidden="true">
              <Type size={20} />
            </span>
            <div>
              <h2>Send text</h2>
              <p className="muted small">
                Paste a note, snippet or log - it travels directly to the receiver, never through
                a server.
              </p>
            </div>
          </div>

          <div className="stack stack-3">
            <label htmlFor="text-input" className="small" style={{ fontWeight: 650 }}>
              Message
            </label>
            <textarea
              id="text-input"
              className="text-input"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste or type anything…"
              rows={9}
              spellCheck={false}
              disabled={busy}
              aria-describedby="text-help"
            />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <p id="text-help" className={`small ${overLimit ? 'danger-text' : 'muted'}`}>
                {charactersLabel} characters · {formatBytes(byteLength)} of {MAX_TEXT_LABEL} max
                {overLimit && ' - shorten the message to continue'}
              </p>
              {text.length > 0 && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setText('')}>
                  Clear
                </button>
              )}
            </div>
          </div>

          {selectionError && (
            <Alert tone="error" title={selectionError.title}>
              {selectionError.detail}
              {selectionError.hint && <div className="alert-hint">{selectionError.hint}</div>}
            </Alert>
          )}

          <ModePicker flow={flow} isGroup={isGroup} groupSize={groupSize} disabled={busy} />

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted small">
              Ready to send <strong>{charactersLabel} characters</strong> ({formatBytes(byteLength)})
            </span>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={handleGenerate}
              disabled={!canGenerate}
            >
              {busy ? (
                <>
                  <Spinner /> Generating code…
                </>
              ) : (
                <>
                  <Copy size={17} aria-hidden="true" />
                  Generate transfer code
                </>
              )}
            </button>
          </div>

          {error && (
            <Alert tone="error" title={error.title}>
              {error.detail}
              {error.hint && <div className="alert-hint">{error.hint}</div>}
            </Alert>
          )}
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="flow container">
      <SendScreens flow={flow} onNavigate={onNavigate} contentType="text" />
    </main>
  );
}
