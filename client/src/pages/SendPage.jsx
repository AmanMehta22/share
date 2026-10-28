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
  User,
  Link2,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { useSenderFlow, SENDER_PHASE, SEND_MODE, GROUP_SIZE_OPTIONS, RECEIVER_ROW_STATE } from '../hooks/useSenderFlow.js';
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

/** One receiver of a group transfer: label, status pill, live progress. */
const ROW_LABELS = {
  [RECEIVER_ROW_STATE.WAITING]: { label: 'Joined', tone: 'info' },
  [RECEIVER_ROW_STATE.APPROVED]: { label: 'Approved', tone: 'ok' },
  [RECEIVER_ROW_STATE.CONNECTING]: { label: 'Connecting…', tone: 'info' },
  [RECEIVER_ROW_STATE.AWAITING_ACCEPT]: { label: 'Reviewing files', tone: 'info' },
  [RECEIVER_ROW_STATE.TRANSFERRING]: { label: 'Receiving', tone: 'ok' },
  [RECEIVER_ROW_STATE.COMPLETED]: { label: 'Done', tone: 'ok' },
  [RECEIVER_ROW_STATE.REJECTED]: { label: 'Declined', tone: 'warn' },
  [RECEIVER_ROW_STATE.CANCELLED]: { label: 'Cancelled', tone: 'neutral' },
  [RECEIVER_ROW_STATE.FAILED]: { label: 'Failed', tone: 'danger' },
  [RECEIVER_ROW_STATE.DISCONNECTED]: { label: 'Left', tone: 'warn' },
};

function ReceiverRow({ row, index, onApprove, onReject }) {
  const status = ROW_LABELS[row.state] ?? { label: row.state, tone: 'neutral' };
  const percent = row.totalBytes > 0 ? Math.floor((row.sentBytes / row.totalBytes) * 100) : 0;
  const canAct = row.state === RECEIVER_ROW_STATE.WAITING;
  const showBytes =
    row.state === RECEIVER_ROW_STATE.TRANSFERRING ||
    row.state === RECEIVER_ROW_STATE.AWAITING_ACCEPT ||
    row.state === RECEIVER_ROW_STATE.COMPLETED;
  return (
    <div className="peer-box receiver-row">
      <span className="receiver-index" aria-hidden="true">
        {row.state === RECEIVER_ROW_STATE.COMPLETED ? <CheckCircle2 size={18} /> : <User size={18} />}
      </span>
      <div className="grow">
        <strong>Receiver {index}</strong>
        {showBytes && (
          <div className="mini-progress" aria-hidden="true">
            <div className="mini-progress-fill" style={{ width: `${percent}%` }} />
          </div>
        )}
        {showBytes && (
          <p className="muted small">
            {formatBytes(row.sentBytes)} / {formatBytes(row.totalBytes)} · {percent}%
            {row.paused && ' · paused'}
            {!row.paused && row.speed > 0 && ` · ${formatBytes(row.speed)}/s`}
            {row.fileName ? ` · ${row.fileName}` : ''}
          </p>
        )}
        {!showBytes && row.error && <p className="small danger-text">{row.error.detail}</p>}
        {!showBytes && !row.error && canAct && (
          <p className="muted small">Waiting for your approval to connect.</p>
        )}
      </div>
      <StatusPill {...status} />
      {canAct && (
        <div className="btn-group">
          <button type="button" className="btn btn-sm" onClick={() => onApprove(row.id)}>
            <UserCheck size={14} aria-hidden="true" />
            Approve
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => onReject(row.id)}>
            <UserX size={14} aria-hidden="true" />
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

export function SendPage({ onNavigate }) {
  const flow = useSenderFlow();

  const {
    phase,
    mode,
    groupSize,
    code,
    selection,
    selectionError,
    peer,
    receivers,
    progress,
    stats,
    paused,
    activeFileName,
    error,
    notice,
    result,
  } = flow;

  const isGroup = mode === SEND_MODE.GROUP;

  // ------------------------------------------------------------ idle / select
  if (phase === SENDER_PHASE.IDLE || phase === SENDER_PHASE.GENERATING) {
    const busy = phase === SENDER_PHASE.GENERATING;
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
              <div className="mode-picker" role="radiogroup" aria-label="Transfer mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!isGroup}
                  className={`mode-card${!isGroup ? ' selected' : ''}`}
                  onClick={() => flow.setMode(SEND_MODE.DIRECT)}
                  disabled={busy}
                >
                  <User size={20} aria-hidden="true" />
                  <strong>One to one</strong>
                  <p className="muted small">A single receiver joins with the code.</p>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={isGroup}
                  className={`mode-card${isGroup ? ' selected' : ''}`}
                  onClick={() => flow.setMode(SEND_MODE.GROUP)}
                  disabled={busy}
                >
                  <Users size={20} aria-hidden="true" />
                  <strong>One to many</strong>
                  <p className="muted small">
                    Up to {groupSize} receivers join with the same code, each with their own direct
                    connection.
                  </p>
                </button>
              </div>

              {isGroup && (
                <label className="row small" style={{ gap: 10 }}>
                  <span className="muted">How many receivers?</span>
                  <select
                    className="select"
                    value={groupSize}
                    onChange={(event) => flow.setGroupSize(Number(event.target.value))}
                    disabled={busy}
                  >
                    {GROUP_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>
                        Up to {size} receivers
                      </option>
                    ))}
                  </select>
                </label>
              )}

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

  // ------------------------------------------------------- waiting / paired
  if (
    phase === SENDER_PHASE.WAITING ||
    phase === SENDER_PHASE.PAIRED ||
    phase === SENDER_PHASE.CONNECTING
  ) {
    const connection = CONNECTION_LABELS[peer.connection];
    const waitingRows = receivers.filter((row) => row.state === RECEIVER_ROW_STATE.WAITING);
    return (
      <main id="main" className="flow container">
        <FlowSteps steps={STEPS} current={stepForPhase(phase)} />
        <div className="card flow-card stack stack-5">
          <div className="code-card card">
            <h2>Your transfer code</h2>
            <p className="muted small" style={{ marginTop: 6 }}>
              {isGroup
                ? `Share this code with up to ${groupSize} receivers. It expires in 15 minutes.`
                : 'Share this code with the receiver. It expires in 15 minutes and works only once.'}
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

          {phase === SENDER_PHASE.WAITING && receivers.length === 0 && (
            <div className="waiting">
              <Spinner size="lg" />
              <div>
                <strong>{isGroup ? 'Waiting for receivers…' : 'Waiting for the receiver…'}</strong>
                <p className="muted small">
                  Enter the code on the other {isGroup ? 'computers' : 'computer'} to join.
                </p>
              </div>
              {connection && <StatusPill {...connection} pulse={peer.connection === 'disconnected'} />}
            </div>
          )}

          {isGroup && receivers.length > 0 && (
            <div className="stack stack-3">
              <div className="peer-box">
                <Users size={20} aria-hidden="true" style={{ color: 'var(--accent)' }} />
                <div className="grow">
                  <strong>
                    {receivers.length} of {groupSize} receivers joined
                  </strong>
                  <p className="muted small">
                    Approve each receiver (or all at once). Everyone gets their own direct
                    connection - nobody else sees the files.
                  </p>
                </div>
              </div>
              {receivers.map((row, index) => (
                <ReceiverRow
                  key={row.id}
                  row={row}
                  index={index + 1}
                  onApprove={flow.approveReceiver}
                  onReject={flow.declineReceiver}
                />
              ))}
              {waitingRows.length > 1 && (
                <div className="btn-group">
                  <button type="button" className="btn btn-primary" onClick={flow.approveAllReceivers}>
                    <UserCheck size={17} aria-hidden="true" />
                    Approve all ({waitingRows.length})
                  </button>
                </div>
              )}
            </div>
          )}

          {!isGroup && phase === SENDER_PHASE.PAIRED && (
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
                <button type="button" className="btn btn-primary" onClick={() => flow.approveReceiver()}>
                  <UserCheck size={17} aria-hidden="true" />
                  Approve & connect
                </button>
                <button type="button" className="btn btn-danger" onClick={() => flow.declineReceiver()}>
                  <UserX size={17} aria-hidden="true" />
                  Decline
                </button>
              </div>
            </div>
          )}

          {!isGroup && phase === SENDER_PHASE.CONNECTING && (
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
    const activeRows = receivers.filter((row) => row.state !== RECEIVER_ROW_STATE.WAITING);
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
                  ? isGroup
                    ? 'Waiting for receivers'
                    : 'Waiting for approval'
                  : isGroup
                    ? `Sending to ${activeRows.length} receivers`
                    : 'Sending files'}
              </h2>
              <p className="muted small">
                {selection?.name} · {selection?.itemCount} items ·{' '}
                {formatBytes(selection?.totalBytes ?? 0)}
                {isGroup && ` · per receiver`}
              </p>
            </div>
            {!isGroup && peer.connection && <StatusPill {...CONNECTION_LABELS[peer.connection]} />}
          </div>

          {phase === SENDER_PHASE.AWAITING_ACCEPT && (
            <Alert tone="info" title="File list sent">
              Each receiver must accept the file list before a single byte is read from disk.
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

          {isGroup && (
            <div className="stack stack-3">
              {receivers.map((row, index) => (
                <ReceiverRow key={row.id} row={row} index={index + 1} onApprove={flow.approveReceiver} onReject={flow.declineReceiver} />
              ))}
            </div>
          )}

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
                  Resume {isGroup && 'all'}
                </button>
              ) : (
                <button type="button" className="btn" onClick={flow.pauseTransfer}>
                  <Pause size={16} aria-hidden="true" />
                  Pause {isGroup && 'all'}
                </button>
              ))}
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => flow.cancelTransfer(isGroup ? 'Cancelled the group transfer' : 'Cancelled by the sender')}
            >
              <XCircle size={16} aria-hidden="true" />
              Cancel {isGroup && 'everyone'}
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
    if (isGroup) {
      const total = result?.receivers?.length ?? 0;
      title = 'Group transfer complete';
      message = `${result?.completedCount ?? total} of ${total} receivers confirmed every file.`;
    }
    details.push(byteDetail('Sent per receiver', result?.sentBytes ?? progress.sentBytes));
    details.push(byteDetail('Total size', result?.totalBytes ?? progress.totalBytes));
    if (result?.fileCount) {
      details.push({
        label: 'Files',
        value: `${result.fileCount} file${result.fileCount === 1 ? '' : 's'}`,
      });
    }
    for (const row of result?.receivers ?? []) {
      details.push({
        label: `Receiver ${row.index}`,
        value:
          row.state === RECEIVER_ROW_STATE.COMPLETED
            ? `received ${formatBytes(row.sentBytes)} ✓`
            : `${ROW_LABELS[row.state]?.label ?? row.state}${row.reason ? ` (${row.reason})` : ''}`,
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
    title = isGroup ? 'Group transfer cancelled' : 'Transfer cancelled';
    message = result?.reason ?? 'Nothing was sent after the cancellation.';
    for (const row of result?.receivers ?? []) {
      details.push({
        label: `Receiver ${row.index}`,
        value:
          row.state === RECEIVER_ROW_STATE.COMPLETED
            ? `received ${formatBytes(row.sentBytes)} ✓`
            : `${ROW_LABELS[row.state]?.label ?? row.state}`,
      });
    }
  } else if (phase === SENDER_PHASE.EXPIRED) {
    status = 'error';
    title = 'Code expired';
    message = error?.detail ?? 'The transfer code expired before anyone used it.';
    tips.push(error?.hint ?? 'Generate a new code and share it again.');
  } else {
    status = 'error';
    title = isGroup ? 'No receiver completed the transfer' : 'Transfer failed';
    message = error?.detail ?? 'Something went wrong.';
    if (error?.hint) tips.push(error.hint);
    for (const row of result?.receivers ?? []) {
      details.push({
        label: `Receiver ${row.index}`,
        value: `${ROW_LABELS[row.state]?.label ?? row.state}${row.reason ? ` (${row.reason})` : ''}`,
      });
    }
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
