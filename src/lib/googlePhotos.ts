// Google Photos import through the shared Vegvisr connection.
//
// The Google OAuth grant (photospicker.mediaitems.readonly) lives in the Vegvisr
// auth worker, keyed by the user's email. This client asks that worker for the
// user's access token (X-API-Token = the same emailVerificationToken VidoCut's
// magic-link login stores), runs the Google Photos Picker session directly, and
// downloads the chosen items through the worker's proxy-image route, because
// Google's media URLs need a bearer token and are not CORS-readable.

const AUTH_BASE = 'https://auth.vegvisr.org';
const PICKER_BASE = 'https://photospicker.googleapis.com/v1';

export const GOOGLE_CONNECT_URL = `${AUTH_BASE}/picker/auth`;

export class NotConnectedError extends Error {
  constructor(message = 'Google Photos is not connected for this account.') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

export type PickedItem = {
  id: string;
  type: 'PHOTO' | 'VIDEO' | string;
  filename: string;
  mimeType: string;
  baseUrl: string;
};

export type ImportPhase =
  | { phase: 'connecting' }
  | { phase: 'choosing' }
  | { phase: 'downloading'; done: number; total: number; filename: string };

export type Identity = { email: string; token: string };

const authHeaders = (id: Identity) => ({ 'Content-Type': 'application/json', 'X-API-Token': id.token });

export async function getAccessToken(id: Identity): Promise<string> {
  const res = await fetch(`${AUTH_BASE}/picker/get-credentials`, {
    method: 'POST',
    headers: authHeaders(id),
    body: JSON.stringify({ user_email: id.email }),
  });
  // 404 = never connected, 410 = the stored Google token expired (1 hour).
  if (res.status === 404 || res.status === 410) throw new NotConnectedError(
    res.status === 410 ? 'The Google Photos connection has expired. Reconnect to continue.' : undefined,
  );
  if (res.status === 401) throw new Error('Your VidoCut login is not valid for Google Photos. Log out and log in again.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success || !data.access_token) throw new Error(data.error || `Could not read the Google connection (${res.status}).`);
  return data.access_token as string;
}

const googleFetch = async (url: string, accessToken: string, init: RequestInit = {}) => {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) } });
  // Google answers 401/403 when the token expired or the scope was revoked.
  if (res.status === 401 || res.status === 403) throw new NotConnectedError('Google rejected the connection. Reconnect to continue.');
  if (!res.ok) throw new Error(`Google Photos error ${res.status}.`);
  return res;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Creates a Picker session, opens it, waits for the user to finish, returns the picked items. */
export async function pickItems(
  accessToken: string,
  openPicker: (uri: string) => void,
  signal: AbortSignal,
  timeoutMs = 5 * 60 * 1000,
): Promise<PickedItem[]> {
  const session = await (await googleFetch(`${PICKER_BASE}/sessions`, accessToken, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  if (!session.pickerUri || !session.id) throw new Error('Google did not return a picker link.');
  // /autoclose makes Google close the picker window when the user taps Done.
  openPicker(`${session.pickerUri}/autoclose`);

  const intervalMs = Math.max(2000, (parseFloat(session.pollingConfig?.pollInterval) || 3) * 1000);
  const deadline = Date.now() + Math.min(timeoutMs, (parseFloat(session.pollingConfig?.timeoutIn) || 300) * 1000);
  try {
    while (Date.now() < deadline) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      await sleep(intervalMs);
      const status = await (await googleFetch(`${PICKER_BASE}/sessions/${session.id}`, accessToken)).json();
      if (status.mediaItemsSet) {
        const items: PickedItem[] = [];
        let pageToken = '';
        do {
          const url = `${PICKER_BASE}/mediaItems?sessionId=${session.id}&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
          const page = await (await googleFetch(url, accessToken)).json();
          for (const it of page.mediaItems || []) {
            if (!it.mediaFile?.baseUrl) continue;
            items.push({
              id: it.id,
              type: it.type,
              filename: it.mediaFile.filename || `${it.id}.${it.type === 'VIDEO' ? 'mp4' : 'jpg'}`,
              mimeType: it.mediaFile.mimeType || (it.type === 'VIDEO' ? 'video/mp4' : 'image/jpeg'),
              baseUrl: it.mediaFile.baseUrl,
            });
          }
          pageToken = page.nextPageToken || '';
        } while (pageToken);
        return items;
      }
    }
    throw new Error('The picker timed out. Try again.');
  } finally {
    // Sessions expire on their own; deleting frees Google's side early. Best effort.
    fetch(`${PICKER_BASE}/sessions/${session.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
  }
}

/** Downloads one picked item as a File, through the auth worker's proxy. */
export async function downloadItem(id: Identity, item: PickedItem): Promise<File> {
  // =dv requests the video bytes, =d the original photo bytes.
  const url = `${item.baseUrl}=${item.type === 'VIDEO' ? 'dv' : 'd'}`;
  const res = await fetch(`${AUTH_BASE}/picker/proxy-image`, {
    method: 'POST',
    headers: authHeaders(id),
    body: JSON.stringify({ baseUrl: url, user_email: id.email }),
  });
  if (res.status === 401 || res.status === 404) throw new NotConnectedError();
  if (!res.ok) throw new Error(`Could not download ${item.filename} (${res.status}).`);
  const blob = await res.blob();
  return new File([blob], item.filename, { type: item.mimeType || blob.type });
}

export async function importFromGooglePhotos(
  id: Identity,
  openPicker: (uri: string) => void,
  onPhase: (p: ImportPhase) => void,
  signal: AbortSignal,
): Promise<File[]> {
  onPhase({ phase: 'connecting' });
  const accessToken = await getAccessToken(id);
  onPhase({ phase: 'choosing' });
  const items = await pickItems(accessToken, openPicker, signal);
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    onPhase({ phase: 'downloading', done: i, total: items.length, filename: items[i].filename });
    files.push(await downloadItem(id, items[i]));
  }
  return files;
}
