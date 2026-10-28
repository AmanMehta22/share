import { User, Users } from 'lucide-react';
import { SEND_MODE, GROUP_SIZE_OPTIONS } from '../hooks/useSenderFlow.js';

/**
 * One-to-one vs one-to-many choice, plus the group-size select.
 * Shared by the "Send files" and "Send text" select screens.
 *
 * @param {{flow: object, isGroup: boolean, groupSize: number, disabled?: boolean}} props
 */
export function ModePicker({ flow, isGroup, groupSize, disabled }) {
  return (
    <div className="stack stack-3">
      <div className="mode-picker" role="radiogroup" aria-label="Transfer mode">
        <button
          type="button"
          role="radio"
          aria-checked={!isGroup}
          className={`mode-card${!isGroup ? ' selected' : ''}`}
          onClick={() => flow.setMode(SEND_MODE.DIRECT)}
          disabled={disabled}
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
          disabled={disabled}
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
            disabled={disabled}
          >
            {GROUP_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                Up to {size} receivers
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
