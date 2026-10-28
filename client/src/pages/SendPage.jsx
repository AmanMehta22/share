import {
  Send,
  Copy,
  Clock,
  UserCheck,
  UserX,
  Pause,
  Play,
  XCircle,
  Users,
  Link2,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import { useSenderFlow, SENDER_PHASE } from '../hooks/useSenderFlow.js';
import { DropZone } from '../components/DropZone.jsx';
import { FileList } from '../components/FileList.jsx';
import { CodeDisplay } from '../components/CodeDisplay.jsx';
import { ProgressBar } from '../components/ProgressBar.jsx';
import { FlowSteps } from '../components/FlowSteps.jsx';
import { ResultScreen } from '../components/ResultScreen.jsx';
import { byteDetail, formatBytes, formatDuration } from '../utils/format.js';
import { Alert } from '../components/Alert.jsx';
import { Spinner, StatusPill } from '../components/Spinner.jsx';

const STEPS = [
  { key: 'select', label: 'Select' },
  { key: 'code', label: 'Share code' },
  { key: 'transfer', label: 'Transfer' },
];

function stepForPhase(phase) {
  if (phase === SENDER_PHASE.IDLE || phase === SENDER_PHASE.GENERATING) return 'select';
  if (
    phase === SENDER_PHASE.WAITING ||
    phase === SENDER_PHASE.PAIRED ||
    phase === SENDER_PHASE.CONNECTING ||
    phase === SENDER_PHASE.EXPIRED
  ) {
    return 'code';
  }
  return 'transfer';
}

const CONNECTION_LABELS = {
  connecting: { label: 'Connecting…', tone: 'info' },
  connected: { label: 'Connected', tone: 'ok' },
  disconnected: { label: 'Reconnecting…', tone: 'warn' },
  failed: { label: 'Connection failed', tone: 'danger' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export function SendPage({ onNavigate }) {
  const flow = useSenderFlow();

  const {
    phase,
    code,
    selection,
    selectionError,
    peer,
    progress,
    stats,
    paused,
    activeFileName,
    error,
    notice,
    result,
  } = flow;

  // ------------------------------------------------------------ idle / select
  if (phase === SENDER_PHASE.IDLE || phase === SENDER_PHASE.GENERATING) {
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

          <DropZone onSelection={flow.setSelection} disabled={phase === SENDER_PHASE.GENERATING} />

          {selectionError && (
            <Alert tone="error" title={selectionError.title}>
              {selectionError.detail}
              {selectionError.hint && <div className="alert-hint">{selectionError.hint}</div>}
            </Alert>
          )}

          <FileList selection={selection} onClear={flow.clearSelection} />

          {selection && (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted small">
                Ready to send <strong>{selection.name}</strong> ({formatBytes(selection.totalBytes)})
              </span>
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={flow.generateCode}
                disabled={phase === SENDER_PHASE.GENERATING}
              >
                {phase === SENDER_PHASE.GENERATING ? (
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

  // ------------------------------------------------------- waiting / paired
  if (
    phase === SENDER_PHASE.WAITING ||
    phase === SENDER_PHASE.PAIRED ||
    phase === SENDER_PHASE.CONNECTING
  ) {
    const connection = CONNECTION_LABELS[peer.connection];
    return (
      <main id="main" className="flow container">
        <FlowSteps steps={STEPS} current={stepForPhase(phase)} />
        <div className="card flow-card stack stack-5">
          <div className="code-card card">
            <h2>Your transfer code</h2>
            <p className="muted small" style={{ marginTop: 6 }}>
              Share this code with the receiver. It expires in 15 minutes and works only once.
            </p>
            <CodeDisplay code={code} />
            <p className="faint small" style={{ marginTop: 12 }}>
              <Clock size={13} style={{ display: 'inline', verticalAlign: '-2px' }} aria-hidden="true" />{' '}
              Keep this tab open - the code dies with it.
            </p>
          </div>

          {notice && (
            <Alert tone={notice.kind === 'warn' ? 'warn' : 'info'}>{notice.text}</Alert>
          )}

          {phase === SENDER_PHASE.WAITING && (
            <div className="waiting">
              <Spinner size="lg" />
              <div>
                <strong>Waiting for the receiver…</strong>
                <p className="muted small">
                  Enter the code on the other computer to join.
                </p>
              </div>
              {connection && <StatusPill {...connection} pulse={peer.connection === 'disconnected'} />}
            </div>
          )}

          {phase === SENDER_PHASE.PAIRED && (
            <div className="stack stack-3">
              <div className="peer-box">
                <Users size={20} aria-hidden="true" style={{ color: 'var(--accent)' }} />
                <div className="grow">
                  <strong>A receiver joined</strong>
                  <p className="muted small">
                    Approve them to start the direct connection and send the file list.
                  </p>
                </div>
                <StatusPill label="Joined" tone="info" />
              </div>
              <div className="btn-group">
                <button type="button" className="btn btn-primary" onClick={flow.approveReceiver}>
                  <UserCheck size={17} aria-hidden="true" />
                  Approve & connect
                </button>
                <button type="button" className="btn btn-danger" onClick={flow.declineReceiver}>
                  <UserX size={17} aria-hidden="true" />
                  Decline
                </button>
              </div>
            </div>
          )}

          {phase === SENDER_PHASE.CONNECTING && (
            <div className="waiting">
              <Spinner size="lg" />
              <div>
                <strong>Connecting directly…</strong>
                <p className="muted small">
                  Negotiating a peer-to-peer route with the receiver.
                </p>
              </div>
              {connection && <StatusPill {...connection} pulse />}
            </div>
          )}

          <div className="btn-group">
            <button
              type="button"
              className="btn"
              onClick={() => flow.cancelTransfer('Cancelled while waiting')}
            >
              <XCircle size={16} aria-hidden="true" />
              Cancel transfer
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

  // ------------------------------------------- awaiting accept / transferring
  if (phase === SENDER_PHASE.AWAITING_ACCEPT || phase === SENDER_PHASE.TRANSFERRING) {
    const percent =
      progress.totalBytes > 0 ? Math.floor((progress.sentBytes / progress.totalBytes) * 100) : 0;
    return (
      <main id="main" className="flow container">
        <FlowSteps steps={STEPS} current="transfer" />
        <div className="card flow-card stack stack-5">
          <div className="flow-title">
            <span className="card-icon" aria-hidden="true">
              <Link2 size={20} />
            </span>
            <div className="grow">
              <h2>
                {phase === SENDER_PHASE.AWAITING_ACCEPT
                  ? 'Waiting for approval'
                  : 'Sending files'}
              </h2>
              <p className="muted small">
                {selection?.name} · {selection?.itemCount} items ·{' '}
                {formatBytes(selection?.totalBytes ?? 0)}
              </p>
            </div>
            {peer.connection && <StatusPill {...CONNECTION_LABELS[peer.connection]} />}
          </div>

          {phase === SENDER_PHASE.AWAITING_ACCEPT && (
            <Alert tone="info" title="File list sent">
              The receiver must accept the file list before a single byte is read from disk.
            </Alert>
          )}

          <ProgressBar
            sentBytes={progress.sentBytes}
            totalBytes={progress.totalBytes}
            speed={stats.speed}
            eta={stats.eta}
            paused={paused}
            fileName={activeFileName}
            label={phase === SENDER_PHASE.AWAITING_ACCEPT ? 'Ready to send' : 'Sending'}
          />

          <div className="stat-grid">
            <div className="stat">
              <div className="stat-label">Progress</div>
              <div className="stat-value accent">{percent}%</div>
            </div>
            <div className="stat">
              <div className="stat-label">Sent</div>
              <div className="stat-value">{formatBytes(progress.sentBytes)}</div>
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
            {phase === SENDER_PHASE.TRANSFERRING &&
              (paused ? (
                <button type="button" className="btn" onClick={flow.resumeTransfer}>
                  <Play size={16} aria-hidden="true" />
                  Resume
                </button>
              ) : (
                <button type="button" className="btn" onClick={flow.pauseTransfer}>
                  <Pause size={16} aria-hidden="true" />
                  Pause
                </button>
              ))}
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => flow.cancelTransfer('Cancelled by the sender')}
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

  // ------------------------------------------------------------- terminal
  const details = [];
  const tips = [];
  let status = 'success';
  let title = 'Transfer complete';
  let message = 'The receiver confirmed every file.';

  if (phase === SENDER_PHASE.COMPLETED) {
    details.push(byteDetail('Sent', result?.sentBytes ?? progress.sentBytes));
    details.push(byteDetail('Total size', result?.totalBytes ?? progress.totalBytes));
    if (result?.fileCount) {
      details.push({
        label: 'Files',
        value: `${result.fileCount} file${result.fileCount === 1 ? '' : 's'}`,
      });
    }
    tips.push('The code is spent - generate a new one for another transfer.');
  } else if (phase === SENDER_PHASE.REJECTED) {
    status = 'error';
    title = 'Receiver declined';
    message = error?.detail ?? 'The receiver did not accept the transfer.';
    tips.push(error?.hint ?? 'Start again and confirm both sides see the same transfer.');
  } else if (phase === SENDER_PHASE.CANCELLED) {
    status = 'cancelled';
    title = 'Transfer cancelled';
    message = result?.reason ?? 'Nothing was sent after the cancellation.';
  } else if (phase === SENDER_PHASE.EXPIRED) {
    status = 'error';
    title = 'Code expired';
    message = error?.detail ?? 'The transfer code expired before anyone used it.';
    tips.push(error?.hint ?? 'Generate a new code and share it again.');
  } else {
    status = 'error';
    title = 'Transfer failed';
    message = error?.detail ?? 'Something went wrong.';
    if (error?.hint) tips.push(error.hint);
  }

  return (
    <main id="main" className="flow container">
      <FlowSteps steps={STEPS} current="transfer" />
      <div className="card flow-card">
        <ResultScreen
          status={status}
          title={title}
          message={message}
          details={details}
          tips={tips}
          onRestart={flow.reset}
          restartLabel="Send another transfer"
        />
        <div className="btn-group" style={{ justifyContent: 'center', marginTop: 20 }}>
          <button type="button" className="btn btn-ghost" onClick={() => onNavigate('home')}>
            Back to home
          </button>
          {status !== 'success' && (
            <AlertTriangle
              size={15}
              aria-hidden="true"
              style={{ alignSelf: 'center', color: 'var(--text-faint)' }}
            />
          )}
        </div>
        <p className="center faint small" style={{ marginTop: 12 }}>
          <ShieldCheck size={13} style={{ display: 'inline', verticalAlign: '-2px' }} aria-hidden="true" />{' '}
          Nothing was uploaded to any server during this transfer.
        </p>
      </div>
    </main>
  );
}
