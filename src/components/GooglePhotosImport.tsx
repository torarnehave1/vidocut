import React, { useRef, useState } from 'react';
import { Image as ImageIcon, Loader2, X } from 'lucide-react';
import { readStoredToken, readStoredUser } from '../lib/auth';
import {
  GOOGLE_CONNECT_URL,
  NotConnectedError,
  importFromGooglePhotos,
  type ImportPhase,
} from '../lib/googlePhotos';

type Props = {
  onFiles: (files: File[]) => void | Promise<void>;
  className?: string;
};

export const GooglePhotosImport: React.FC<Props> = ({ onFiles, className }) => {
  const [phase, setPhase] = useState<ImportPhase | null>(null);
  const [error, setError] = useState('');
  const [needsConnect, setNeedsConnect] = useState(false);
  const [pickerLink, setPickerLink] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const busy = phase !== null;

  const start = async () => {
    const user = readStoredUser();
    const token = readStoredToken();
    setError('');
    setNeedsConnect(false);
    setPickerLink('');
    if (!user || !token) {
      setError('Log out and log in again, then retry.');
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const files = await importFromGooglePhotos(
        { email: user.email, token },
        (uri) => {
          // If the browser blocks the popup, keep the link so the user can tap it.
          if (!window.open(uri, '_blank')) setPickerLink(uri);
        },
        setPhase,
        ctrl.signal,
      );
      if (files.length > 0) await onFiles(files);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // cancelled by the user
      } else if (err instanceof NotConnectedError) {
        setNeedsConnect(true);
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Google Photos import failed.');
      }
    } finally {
      setPhase(null);
      setPickerLink('');
      abortRef.current = null;
    }
  };

  const label =
    phase?.phase === 'connecting' ? 'Connecting to Google...'
    : phase?.phase === 'choosing' ? 'Choose in the Google Photos window...'
    : phase?.phase === 'downloading' ? `Downloading ${phase.done + 1} of ${phase.total}...`
    : 'Import from Google Photos';

  return (
    <div className={className}>
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="flex-1 min-h-11 py-3 px-4 bg-white/5 hover:bg-white/10 disabled:opacity-70 border border-white/20 rounded-xl font-bold flex items-center justify-center gap-2 transition-all text-sm"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4 text-accent" />}
          <span>{label}</span>
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            aria-label="Cancel Google Photos import"
            className="w-11 min-h-11 rounded-xl border border-white/20 hover:bg-white/10 flex items-center justify-center text-slate-300"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {pickerLink && (
        <a href={pickerLink} target="_blank" rel="noreferrer" className="mt-2 block text-sm text-accent underline">
          The window was blocked. Tap here to open Google Photos.
        </a>
      )}

      {error && (
        <div role="alert" className="mt-2 text-sm text-red-300 space-y-1">
          <p>{error}</p>
          {needsConnect && (
            <p className="text-slate-300">
              <a href={GOOGLE_CONNECT_URL} className="text-accent underline">Connect Google Photos</a>
              {' '}(you return to vegvisr.org when done, then come back here and try again).
            </p>
          )}
        </div>
      )}
    </div>
  );
};
