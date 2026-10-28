import { File, Folder, FileArchive } from 'lucide-react';
import { formatBytes } from '../utils/format.js';

const MAX_VISIBLE = 8;

function iconFor(file) {
  if (file.dir) return Folder;
  if (/\.(zip|rar|7z|tar|gz|tgz)$/i.test(file.name)) return FileArchive;
  return File;
}

/**
 * Scrollable list of the current selection with a summary bar.
 * Shows at most MAX_VISIBLE rows inline; the rest are summarized so huge
 * folders do not freeze the page.
 */
export function FileList({ selection, onClear, max = MAX_VISIBLE }) {
  if (!selection) return null;

  const rows = [...selection.dirs.map((d) => ({ ...d, dir: true })), ...selection.files];
  const visible = rows.slice(0, max);
  const hidden = rows.length - visible.length;

  return (
    <div className="stack stack-3">
      <div className="summary-bar">
        <div className="row">
          <strong>{selection.name}</strong>
          <span className="muted small">
            {selection.itemCount} item{selection.itemCount === 1 ? '' : 's'} ·{' '}
            {formatBytes(selection.totalBytes)}
          </span>
        </div>
        {onClear && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      <ul className="file-list" aria-label="Selected files">
        {visible.map((item) => {
          const Icon = iconFor(item);
          return (
            <li key={item.path} className="file-row">
              <Icon size={16} aria-hidden="true" />
              <span className="file-name" title={item.path}>
                {item.path}
              </span>
              <span className="file-size">{item.dir ? 'folder' : formatBytes(item.size)}</span>
            </li>
          );
        })}
        {hidden > 0 && (
          <li className="file-row faint" aria-hidden="true">
            <File size={16} aria-hidden="true" />
            <span className="file-name">…and {hidden} more</span>
          </li>
        )}
      </ul>
    </div>
  );
}
