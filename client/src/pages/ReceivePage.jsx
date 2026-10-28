import { useCallback, useRef, useState } from 'react';
import {
  Download,
  LogIn,
  Pause,
  Play,
  XCircle,
  RefreshCw,
  FileText,
  Clock,
  ShieldCheck,
  Inbox,
  HardDriveDownload,
  FileArchive,
  Folder,
} from 'lucide-react';
import { useReceiverFlow, RECEIVER_PHASE, SAVE_MODE } from '../hooks/useReceiverFlow.js';
import { FileList } from '../components/FileList.jsx';
import { ProgressBar } from '../components/ProgressBar.jsx';
import { FlowSteps } from '../components/FlowSteps.jsx';
import { ResultScreen } from '../components/ResultScreen.jsx';
import { Alert } from '../components/Alert.jsx';
import { Spinner, StatusPill } from '../components/Spinner.jsx';
import { byteDetail, formatBytes, formatDuration } from '../utils/format.js';

const STEPS = [
  { key: 'code', label: 'Enter code' },
  { key: 'confirm', label: 'Confirm' },
  { key: 'receive', label: 'Receive' },
];

function stepForPhase(phase) {
  if (phase === RECEIVER_PHASE.IDLE || phase === RECEIVER_PHASE.JOINING) return 'code';
  if (
    phase === RECEIVER_PHASE.WAITING ||
    phase === RECEIVER_PHASE.CONNECTING ||
    phase === RECEIVER_PHASE.DECIDING
  ) {
    return 'confirm';
  }
  return 'receive';
}

const CONNECTION_LABELS = {
  connecting: { label: 'Connecting…', tone: 'info' },
  connected: { label: 'Connected', tone: 'ok' },
  disconnected: { label: 'Reconnecting…', tone: 'warn' },
  failed: { label: 'Connection failed', tone: 'danger' },
  closed: { label: 'Closed', tone: 'neutral' },
};

/** Convert a manifest into FileList-compatible rows (files only, capped). */
function manifestAsSelection(manifest, name = 'Incoming transfer') {
  if (!manifest) return null;
  const files = manifest.files
    .filter((entry) => !entry.dir)
    .slice(0, 200)
    .map((entry) => ({ path: entry.path, name: entry.name, size: entry.size, dir: false }));
  const dirs = manifest.files
    .filter((entry) => entry.dir)
    .slice(0, 50)
    .map((entry) => ({ path: entry.path, name: entry.name, dir: true }));
  return {
    name,
    itemCount: manifest.files.length,
    fileCount: manifest.fileCount,
    dirCount: manifest.files.length - manifest.fileCount,
    totalBytes: manifest.totalBytes,
    files,
    dirs,
  };
}

export function ReceivePage({ onNavigate }) {
  const flow = useReceiverFlow();
  const [code, setCode] = useState('');
  const codeInputRef = useRef(null);

  const {
    phase,
    manifest,
    error,
    result,
    progress,
    stats,
    paused,
    activeFileName,
    saveMode,
    saveModes,
    packaging,
    filesSaved,
    peer,
    redownload,
    redownloadAll,
  } = flow;

  const handleCodeChange = useCallback((event) => {
    // Uppercase as the user types; normalization/validation happens on submit.
    setCode(event.target.value.toUpperCase());
  }, []);

  const handleConnect = useCallback(
    (event) => {
      event?.preventDefault();
      flow.connect(code);
    },
    [code, flow]
  );

  // ------------------------------------------------------------ idle / join
  if (phase === RECEIVER_PHASE.IDLE || phase === RECEIVER_PHASE.JOINING) {
    return (
      <main id="main" className="flow container">
        <FlowSteps steps={STEPS} current={stepForPhase(phase)} />
        <div className="card flow-card stack stack-5">
          <div className="flow-title">
            <span className="card-icon alt" aria-hidden="true">
              <Download size={20} />
            </span>
            <div>
              <h2>Receive files</h2>
              <p className="muted small">
                Enter the code shown on the sender's screen. No account needed.
              </p>
            </div>
          </div>

          <form onSubmit={handleConnect} className="stack stack-4">
            <label htmlFor="code-input" className="small" style={{ fontWeight: 650 }}>
              Transfer code
            </label>
            <input
              id="code-input"
              ref={codeInputRef}
              className={`code-input ${error ? 'invalid' : ''}`}
              placeholder="ABCD-EFGH-JKLM-NPQR"
              value={code}
              onChange={handleCodeChange}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck="false"
              maxLength={24}
              disabled={phase === RECEIVER_PHASE.JOINING}
              aria-describedby="code-help"
            />
            <p id="code-help" className="muted small">
              16 letters and digits in 4 groups. Codes never contain I, L, O, 0 or 1.
            </p>

            <button
              type="submit"
              className="btn btn-primary btn-lg btn-block"
              disabled={phase === RECEIVER_PHASE.JOINING || code.replace(/-/g, '').length < 16}
            >
              {phase === RECEIVER_PHASE.JOINING ? (
                <>
                  <Spinner /> Joining…
                </>
              ) : (
                <>
                  <LogIn size={17} aria-hidden="true" />
                  Connect to sender
                </>
              )}
            </button>
          </form>

          {error && (
            <Alert tone="error" title={error.title}>
              {error.detail}
              {error.hint && <div className="alert-hint">{error.hint}</div>}
            </Alert>
          )}

          <p className="faint small center">
            <Clock size={13} style={{ display: 'inline', verticalAlign: '-2px' }} aria-hidden="true" />{' '}
            Codes expire 15 minutes after the sender generates them.
          </p>
        </div>
      </main>
    );
  }

  // -------------------------------------------------------- waiting / connect
  if (phase === RECEIVER_PHASE.WAITING || phase === RECEIVER_PHASE.CONNECTING) {
    const connection = CONNECTION_LABELS[peer.connection];
    return (
      <main id="main" className="flow container">
        <FlowSteps steps={STEPS} current="confirm" />
        <div className="card flow-card stack stack-5">
          <div className="waiting">
            <Spinner size="lg" />
            <div>
              <strong>
                {phase === RECEIVER_PHASE.WAITING
                  ? 'Waiting for the sender to approve…'
                  : 'Connecting directly…'}
              </strong>
              <p className="muted small">
                {phase === RECEIVER_PHASE.WAITING
                  ? 'The sender must approve this join request on their screen.'
                  : 'Negotiating a peer-to-peer route. This can take a few seconds.'}
              </p>
            </div>
            {connection && <StatusPill {...connection} pulse />}
          </div>

          <div className="btn-group" style={{ justifyContent: 'center' }}>
            <button
              type="button"
              className="btn"
              onClick={() => flow.cancelTransfer('Left the session')}
            >
              <XCircle size={16} aria-hidden="true" />
              Cancel
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

  // ------------------------------------------------------------- deciding
  if (phase === RECEIVER_PHASE.DECIDING) {
    const incoming = manifestAsSelection(manifest);
    return (
      <main id="main" className="flow container">
        <FlowSteps steps={STEPS} current="confirm" />
        <div className="card flow-card wide stack stack-5">
          <div className="flow-title">
            <span className="card-icon alt" aria-hidden="true">
              <Inbox size={20} />
            </span>
            <div className="grow">
              <h2>Incoming transfer</h2>
              <p className="muted small">
                Review exactly what is being shared. Nothing is received until you accept.
              </p>
            </div>
            {peer.connection && <StatusPill {...CONNECTION_LABELS[peer.connection]} />}
          </div>

          <div className="summary-bar">
            <div className="row">
              <FileText size={16} aria-hidden="true" style={{ color: 'var(--accent)' }} />
              <strong>
                {manifest?.fileCount} file{manifest?.fileCount === 1 ? '' : 's'}
                {manifest?.hasDirectories && ' in folders'}
              </strong>
              <span className="muted small">· {formatBytes(manifest?.totalBytes ?? 0)}</span>
            </div>
          </div>

          <FileList selection={incoming} max={10} />

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 650, marginBottom: 10 }}>
              How do you want to save it?
            </legend>
            <div className="choice-list">
              {saveModes.map((option) => (
                <label
                  key={option.mode}
                  className={`choice ${saveMode === option.mode ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="save-mode"
                    value={option.mode}
                    checked={saveMode === option.mode}
                    onChange={() => flow.setSaveMode(option.mode)}
                  />
                  <span>
                    <span className="choice-title">
                      {option.mode === SAVE_MODE.DIRECTORY && (
                        <Folder size={15} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 6 }} aria-hidden="true" />
                      )}
                      {option.mode === SAVE_MODE.ZIP && (
                        <FileArchive size={15} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 6 }} aria-hidden="true" />
                      )}
                      {option.label}
                    </span>
                    <br />
                    <span className="choice-desc">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="btn-group">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => flow.acceptTransfer()}
            >
              <Download size={17} aria-hidden="true" />
              Accept & receive
            </button>
            <button
              type="button"
              className="btn btn-danger btn-lg"
              onClick={() => flow.rejectTransfer()}
            >
              <XCircle size={17} aria-hidden="true" />
              Reject
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

  // --------------------------------------------------------- transferring
  if (phase === RECEIVER_PHASE.TRANSFERRING) {
    const percent =
      progress.totalBytes > 0 ? Math.floor((progress.receivedBytes / progress.totalBytes) * 100) : 0;
    return (
      <main id="main" className="flow container">
        <FlowSteps steps={STEPS} current="receive" />
        <div className="card flow-card stack stack-5">
          <div className="flow-title">
            <span className="card-icon alt" aria-hidden="true">
              <HardDriveDownload size={20} />
            </span>
            <div className="grow">
              <h2>Receiving files</h2>
              <p className="muted small">
                {saveMode === SAVE_MODE.DIRECTORY && 'Streaming into the folder you chose.'}
                {saveMode === SAVE_MODE.ZIP && 'Buffering in memory - packed into a ZIP at the end.'}
                {saveMode === SAVE_MODE.DOWNLOAD && 'Saving via your browser download.'}
              </p>
            </div>
            {peer.connection && <StatusPill {...CONNECTION_LABELS[peer.connection]} />}
          </div>

          <ProgressBar
            receivedBytes={progress.receivedBytes}
            totalBytes={progress.totalBytes}
            speed={stats.speed}
            eta={stats.eta}
            paused={paused}
            fileName={activeFileName}
            label="Receiving"
          />

          <div className="stat-grid">
            <div className="stat">
              <div className="stat-label">Progress</div>
              <div className="stat-value accent">{percent}%</div>
            </div>
            <div className="stat">
              <div className="stat-label">Received</div>
              <div className="stat-value">{formatBytes(progress.receivedBytes)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Files done</div>
              <div className="stat-value">
                {filesSaved}/{manifest?.fileCount ?? '?'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Speed</div>
              <div className="stat-value">
                {stats.speed > 0 ? `${formatBytes(stats.speed)}/s` : '—'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">ETA</div>
              <div className="stat-value">
                {stats.eta !== null && stats.eta > 0 ? formatDuration(stats.eta) : '—'}
              </div>
            </div>
          </div>

          <div className="btn-group">
            {paused ? (
              <button type="button" className="btn" onClick={flow.resumeTransfer}>
                <Play size={16} aria-hidden="true" />
                Resume
              </button>
            ) : (
              <button type="button" className="btn" onClick={flow.pauseTransfer}>
                <Pause size={16} aria-hidden="true" />
                Pause
              </button>
            )}
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => flow.cancelTransfer('Cancelled by the receiver')}
            >
              <XCircle size={16} aria-hidden="true" />
              Cancel
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

  // packaging into ZIP after transfer finished
  if (packaging) {
    return (
      <main id="main" className="flow container">
        <FlowSteps steps={STEPS} current="receive" />
        <div className="card flow-card">
          <div className="waiting">
            <Spinner size="lg" />
            <div>
              <strong>Packing into a ZIP…</strong>
              <p className="muted small">
                Everything was received; this happens locally in your browser.
              </p>
            </div>
          </div>
          <ProgressBar
            receivedBytes={packaging.done ?? 0}
            totalBytes={packaging.total ?? 0}
            label="Packing files"
          />
        </div>
      </main>
    );
  }

  // ------------------------------------------------------------- terminal
  const details = [];
  const tips = [];
  let status = 'success';
  let title = 'Transfer complete';
  let message = 'All files were received and verified.';

  if (phase === RECEIVER_PHASE.COMPLETED) {
    details.push(byteDetail('Received', result?.receivedBytes ?? progress.receivedBytes));
    details.push({
      label: 'Files',
      value: `${result?.fileCount ?? manifest?.fileCount ?? 0} file${
        (result?.fileCount ?? manifest?.fileCount ?? 0) === 1 ? '' : 's'
      }`,
    });
    if (result?.savedTo === 'zip' && result?.zipName) {
      details.push({ label: 'Saved as', value: result.zipName });
    }
    if (result?.savedTo === 'folder') {
      details.push({ label: 'Saved to', value: 'the folder you chose' });
    }
    if (result?.needsManualDownload) {
      status = 'cancelled';
      title = 'Received - download blocked';
      message =
        'The browser blocked multiple automatic downloads. Use the buttons below to save each file.';
      tips.push('Alternatively, reconnect and pick "Save into a folder" or "ZIP" next time.');
    }
  } else if (phase === RECEIVER_PHASE.REJECTED) {
    status = 'cancelled';
    title = 'Transfer declined';
    message = result?.reason ?? 'You declined the transfer.';
    tips.push('The sender was notified. Start again if this was a mistake.');
  } else if (phase === RECEIVER_PHASE.CANCELLED) {
    status = 'cancelled';
    title = 'Transfer cancelled';
    message = result?.reason ?? 'The transfer was cancelled before it finished.';
    if (result?.by === 'sender') {
      tips.push('The sender cancelled. Ask them to start a new transfer with a fresh code.');
    }
  } else {
    status = 'error';
    title = 'Transfer failed';
    message = error?.detail ?? 'Something went wrong.';
    if (error?.hint) tips.push(error.hint);
    tips.push('No incomplete file was kept - a failed transfer is rolled back.');
  }

  return (
    <main id="main" className="flow container">
      <FlowSteps steps={STEPS} current="receive" />
      <div className="card flow-card">
        <ResultScreen
          status={status}
          title={title}
          message={message}
          details={details}
          tips={tips}
          onRestart={flow.reset}
          restartLabel="Receive another transfer"
        />

        {phase === RECEIVER_PHASE.COMPLETED && result?.needsManualDownload && (
          <div className="btn-group" style={{ justifyContent: 'center', marginTop: 16 }}>
            <button type="button" className="btn btn-primary" onClick={redownloadAll}>
              <Download size={16} aria-hidden="true" />
              Download all files
            </button>
            {result?.downloads?.map((item) => (
              <button
                key={item.path}
                type="button"
                className="btn"
                onClick={() => redownload(item)}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}

        <div className="btn-group" style={{ justifyContent: 'center', marginTop: 20 }}>
          <button type="button" className="btn btn-ghost" onClick={() => onNavigate('home')}>
            <RefreshCw size={15} aria-hidden="true" />
            Back to home
          </button>
        </div>
        <p className="center faint small" style={{ marginTop: 12 }}>
          <ShieldCheck size={13} style={{ display: 'inline', verticalAlign: '-2px' }} aria-hidden="true" />{' '}
          Files were written by your browser - never through our servers (we don't have any).
        </p>
      </div>
    </main>
  );
}
