import {
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
import { SENDER_PHASE, SEND_MODE, RECEIVER_ROW_STATE } from '../hooks/useSenderFlow.js';
import { STEPS, stepForPhase, CONNECTION_LABELS } from '../utils/sendSteps.js';
import { CodeDisplay } from './CodeDisplay.jsx';
import { ProgressBar } from './ProgressBar.jsx';
import { FlowSteps } from './FlowSteps.jsx';
import { ResultScreen } from './ResultScreen.jsx';
import { byteDetail, formatBytes, formatDuration } from '../utils/format.js';
import { Alert } from './Alert.jsx';
import { Spinner, StatusPill } from './Spinner.jsx';

/**
 * Screens shared by the "Send files" and "Send text" pages: the code/waiting
 * screen, the live transfer screen and the terminal result screen.
 *
 * Everything after payload selection is identical for both content types -
 * the same code, approval, WebRTC, per-receiver rows and honest outcomes.
 * `contentType` only tweaks a few labels.
 */

/** One receiver of a group transfer: label, status pill, live progress. */
const ROW_LABELS = {
  [RECEIVER_ROW_STATE.WAITING]: { label: 'Joined', tone: 'info' },
  [RECEIVER_ROW_STATE.APPROVED]: { label: 'Approved', tone: 'ok' },
  [RECEIVER_ROW_STATE.CONNECTING]: { label: 'Connecting…', tone: 'info' },
  [RECEIVER_ROW_STATE.AWAITING_ACCEPT]: { label: 'Reviewing', tone: 'info' },
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

/**
 * Renders everything after payload selection for a sender flow.
 * @param {{flow: object, onNavigate: (view:string)=>void, contentType?: 'files'|'text'}} props
 */
export function SendScreens({ flow, onNavigate, contentType = 'files' }) {
  const {
    phase,
    mode,
    groupSize,
    code,
    selection,
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
  const isText = contentType === 'text';

  // ------------------------------------------------------- waiting / paired
  if (
    phase === SENDER_PHASE.WAITING ||
    phase === SENDER_PHASE.PAIRED ||
    phase === SENDER_PHASE.CONNECTING
  ) {
    const connection = CONNECTION_LABELS[peer.connection];
    const waitingRows = receivers.filter((row) => row.state === RECEIVER_ROW_STATE.WAITING);
    return (
      <>
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

          {notice && <Alert tone={notice.kind === 'warn' ? 'warn' : 'info'}>{notice.text}</Alert>}

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
                    connection - nobody else sees the data.
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
                    Approve them to start the direct connection and send the details.
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
                <p className="muted small">Negotiating a peer-to-peer route with the receiver.</p>
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
      </>
    );
  }

  // ------------------------------------------- awaiting accept / transferring
  if (phase === SENDER_PHASE.AWAITING_ACCEPT || phase === SENDER_PHASE.TRANSFERRING) {
    const percent =
      progress.totalBytes > 0 ? Math.floor((progress.sentBytes / progress.totalBytes) * 100) : 0;
    const activeRows = receivers.filter((row) => row.state !== RECEIVER_ROW_STATE.WAITING);
    const subtitle = isText
      ? `Text message · ${selection?.characters ?? 0} characters · ${formatBytes(selection?.totalBytes ?? 0)}`
      : `${selection?.name} · ${selection?.itemCount} items · ${formatBytes(selection?.totalBytes ?? 0)}`;
    return (
      <>
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
                    : isText
                      ? 'Sending text'
                      : 'Sending files'}
              </h2>
              <p className="muted small">
                {subtitle}
                {isGroup && ' · per receiver'}
              </p>
            </div>
            {!isGroup && peer.connection && <StatusPill {...CONNECTION_LABELS[peer.connection]} />}
          </div>

          {phase === SENDER_PHASE.AWAITING_ACCEPT && (
            <Alert tone="info" title={isText ? 'Message details sent' : 'File list sent'}>
              {isText
                ? 'The receiver must accept before any of the message is sent.'
                : 'Each receiver must accept the file list before a single byte is read from disk.'}
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
                <ReceiverRow
                  key={row.id}
                  row={row}
                  index={index + 1}
                  onApprove={flow.approveReceiver}
                  onReject={flow.declineReceiver}
                />
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
              <div className="stat-value">{stats.speed > 0 ? `${formatBytes(stats.speed)}/s` : '—'}</div>
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
              onClick={() =>
                flow.cancelTransfer(isGroup ? 'Cancelled the group transfer' : 'Cancelled by the sender')
              }
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
      </>
    );
  }

  // ------------------------------------------------------------- terminal
  const details = [];
  const tips = [];
  let status = 'success';
  let title = 'Transfer complete';
  let message = isText ? 'The receiver got the message.' : 'The receiver confirmed every file.';

  if (phase === SENDER_PHASE.COMPLETED) {
    if (isGroup) {
      const total = result?.receivers?.length ?? 0;
      title = 'Group transfer complete';
      message = `${result?.completedCount ?? total} of ${total} receivers confirmed ${
        isText ? 'the message' : 'every file'
      }.`;
    }
    details.push(byteDetail('Sent per receiver', result?.sentBytes ?? progress.sentBytes));
    details.push(byteDetail('Total size', result?.totalBytes ?? progress.totalBytes));
    if (isText) {
      details.push({ label: 'Characters', value: `${selection?.characters ?? 0}` });
    } else if (result?.fileCount) {
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
    title = isGroup ? 'No receiver completed the transfer' : isText ? 'Message not delivered' : 'Transfer failed';
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
    <>
      <FlowSteps steps={STEPS} current="transfer" />
      <div className="card flow-card">
        <ResultScreen
          status={status}
          title={title}
          message={message}
          details={details}
          tips={tips}
          onRestart={flow.reset}
          restartLabel={isText ? 'Send another message' : 'Send another transfer'}
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
    </>
  );
}
