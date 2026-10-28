import { useCallback, useRef, useState } from 'react';
import { UploadCloud, FolderOpen, FileUp } from 'lucide-react';
import { collectFromDrop, collectFromInput, supportsDirectorySelection } from '../utils/selection.js';

/**
 * Drag-and-drop surface plus explicit browse buttons.
 *
 * Buttons are real <button> elements (keyboard accessible); the drop zone
 * itself is a div with an accessible label. Hidden file inputs sit behind
 * them so the browser's own picker does the work.
 */
export function DropZone({ onSelection, disabled = false }) {
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState(null);
  const filesInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const supportsFolder = supportsDirectorySelection();

  const handleError = useCallback((error) => {
    setLocalError(error?.message ?? 'Could not read that selection.');
  }, []);

  // ---------------------------------------------------------------- drag

  const handleDragOver = useCallback(
    (event) => {
      if (disabled) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDragActive(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((event) => {
    // Only react when the pointer actually leaves the zone (children fire
    // dragleave too).
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    async (event) => {
      if (disabled) return;
      event.preventDefault();
      setDragActive(false);
      setLocalError(null);
      setBusy(true);
      try {
        const selection = await collectFromDrop(event.dataTransfer);
        onSelection(selection);
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
      }
    },
    [disabled, handleError, onSelection]
  );

  // ---------------------------------------------------------------- pickers

  const handleFilesChange = useCallback(
    async (event) => {
      const input = event.target;
      const fileList = input.files;
      if (!fileList || fileList.length === 0) return;
      setLocalError(null);
      setBusy(true);
      try {
        const selection = collectFromInput(fileList);
        onSelection(selection);
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        // Reset so the same file can be picked again after a clear.
        input.value = '';
      }
    },
    [handleError, onSelection]
  );

  const handleFolderChange = useCallback(
    async (event) => {
      const input = event.target;
      const fileList = input.files;
      if (!fileList || fileList.length === 0) return;
      setLocalError(null);
      setBusy(true);
      try {
        const selection = collectFromInput(fileList, { directory: true });
        onSelection(selection);
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
        input.value = '';
      }
    },
    [handleError, onSelection]
  );

  // ---------------------------------------------------------------- render

  return (
    <div className="stack stack-3">
      <div
        className={[
          'dropzone',
          dragActive ? 'dropzone-active' : '',
          disabled ? 'dropzone-disabled' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Drop files or a folder here, or use the buttons below"
        aria-disabled={disabled || undefined}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            filesInputRef.current?.click();
          }
        }}
      >
        <span className="dropzone-icon" aria-hidden="true">
          <UploadCloud size={26} />
        </span>
        <div className="dropzone-title">
          {dragActive ? 'Drop to add' : 'Drag & drop files or a folder'}
        </div>
        <p className="dropzone-hint">
          ZIP files work best for folders on any browser. Folder structure is preserved when both
          sides support it.
        </p>

        <input
          ref={filesInputRef}
          className="hidden-input"
          type="file"
          multiple
          onChange={handleFilesChange}
          disabled={disabled || busy}
          aria-hidden="true"
          tabIndex={-1}
        />
        {supportsFolder && (
          <input
            ref={folderInputRef}
            className="hidden-input"
            type="file"
            // webkitdirectory is non-standard but is the only way to pick a
            // folder with structure; feature-detected above.
            webkitdirectory=""
            directory=""
            onChange={handleFolderChange}
            disabled={disabled || busy}
            aria-hidden="true"
            tabIndex={-1}
          />
        )}
      </div>

      <div className="btn-group">
        <button
          type="button"
          className="btn"
          onClick={() => filesInputRef.current?.click()}
          disabled={disabled || busy}
        >
          <FileUp size={16} aria-hidden="true" />
          Browse files
        </button>
        {supportsFolder && (
          <button
            type="button"
            className="btn"
            onClick={() => folderInputRef.current?.click()}
            disabled={disabled || busy}
          >
            <FolderOpen size={16} aria-hidden="true" />
            Browse folder
          </button>
        )}
      </div>

      {localError && (
        <div className="alert alert-error" role="alert">
          <UploadCloud size={18} aria-hidden="true" />
          <div>{localError}</div>
        </div>
      )}
    </div>
  );
}
