import { Send, Copy } from 'lucide-react';
import { useSenderFlow, SENDER_PHASE, SEND_MODE } from '../hooks/useSenderFlow.js';
import { DropZone } from '../components/DropZone.jsx';
import { FileList } from '../components/FileList.jsx';
import { FlowSteps } from '../components/FlowSteps.jsx';
import { ModePicker } from '../components/ModePicker.jsx';
import { SendScreens } from '../components/SendScreens.jsx';
import { STEPS, stepForPhase } from '../utils/sendSteps.js';
import { formatBytes } from '../utils/format.js';
import { Alert } from '../components/Alert.jsx';
import { Spinner } from '../components/Spinner.jsx';

/**
 * Send files/folders: select payload -> pick mode -> generate code, then the
 * shared SendScreens render the waiting, transfer and result screens.
 */
export function SendPage({ onNavigate }) {
  const flow = useSenderFlow();
  const { phase, mode, groupSize, selection, selectionError, error } = flow;
  const busy = phase === SENDER_PHASE.GENERATING;
  const isGroup = mode === SEND_MODE.GROUP;

  // ------------------------------------------------------------ idle / select
  if (phase === SENDER_PHASE.IDLE || busy) {
    return (
      <main id="main" className="flow container">
        <FlowSteps steps={STEPS} current={stepForPhase(phase)} />
        <div className="card flow-card stack stack-5">
          <div className="flow-title">
            <span className="card-icon" aria-hidden="true">
              <Send size={20} />
            </span>
            <div>
              <h2>Send files</h2>
              <p className="muted small">Nothing is uploaded - the transfer will be direct.</p>
            </div>
          </div>

          <DropZone onSelection={flow.setSelection} disabled={busy} />

          {selectionError && (
            <Alert tone="error" title={selectionError.title}>
              {selectionError.detail}
              {selectionError.hint && <div className="alert-hint">{selectionError.hint}</div>}
            </Alert>
          )}

          <FileList selection={selection} onClear={flow.clearSelection} />

          {selection && (
            <div className="stack stack-3">
              <ModePicker flow={flow} isGroup={isGroup} groupSize={groupSize} disabled={busy} />

              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted small">
                  Ready to send <strong>{selection.name}</strong> ({formatBytes(selection.totalBytes)})
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  onClick={flow.generateCode}
                  disabled={busy}
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
            </div>
          )}

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
      <SendScreens flow={flow} onNavigate={onNavigate} contentType="files" />
    </main>
  );
}
