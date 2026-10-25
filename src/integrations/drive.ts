import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface DriveTokens { accessToken: string; refreshToken?: string; expiresAt: number }
export interface AuthSession { url: string; state: string; verifier: string; redirectUri: string; createdAt: number }
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  driveId?: string;
  size?: string;
  path?: string;
}
export interface DriveOptions {
  clientId: string;
  clientSecret?: string;
  getTokens: () => Promise<DriveTokens | undefined>;
  setTokens: (tokens: DriveTokens | undefined) => Promise<void>;
  fetch?: typeof fetch;
}
export interface ListFolderOptions {
  query?: string;
  mimeType?: string;
  recursive?: boolean;
  onPage?: (files: DriveFile[]) => void;
}
export class DriveError extends Error {
  constructor(public code: 'auth' | 'permission' | 'network' | 'api' | 'pagination', message: string, public partialFiles: DriveFile[] = []) { super(message); }
}
const folderMime = 'application/vnd.google-apps.folder';
const fields = 'id,name,mimeType,modifiedTime,webViewLink,parents,driveId,size';
const endpoint = 'https://www.googleapis.com/drive/v3/files';

export function createAuthSession(clientId: string, callbackUri: string): AuthSession {
  if (!clientId.trim()) throw new Error('Set a Google Desktop OAuth client ID first.');
  const callback = new URL(callbackUri);
  if (callback.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(callback.hostname)) {
    throw new Error('Desktop OAuth requires an HTTP loopback callback. Forward the port through VS Code.');
  }
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: callbackUri, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.metadata.readonly', access_type: 'offline', prompt: 'consent',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state,
  }).toString();
  return { url: url.toString(), state, verifier, redirectUri: callbackUri, createdAt: Date.now() };
}

export class GoogleDrive {
  private readonly request: typeof fetch;
  private refreshing?: Promise<DriveTokens>;
  private readonly cached = new Map<string, { fetchedAt: string; files: DriveFile[] }>();
  constructor(private readonly options: DriveOptions) { this.request = options.fetch ?? fetch; }

  async getConnectionState(): Promise<boolean> { return !!await this.options.getTokens(); }
  getCachedFiles(folderId: string): { fetchedAt: string; files: DriveFile[] } | undefined { return this.cached.get(folderId); }
  async disconnect(): Promise<void> { await this.options.setTokens(undefined); this.cached.clear(); }

  async exchangeCode(session: AuthSession, code: string, state: string): Promise<void> {
    const received = Buffer.from(state), expected = Buffer.from(session.state);
    if (received.length !== expected.length || !timingSafeEqual(received, expected) || Date.now() - session.createdAt > 10 * 60_000) {
      throw new DriveError('auth', 'The sign-in response expired or does not match this request. Start sign-in again.');
    }
    if (!code) throw new DriveError('auth', 'Google did not return an authorization code.');
    await this.tokenRequest({ code, code_verifier: session.verifier, redirect_uri: session.redirectUri, grant_type: 'authorization_code' });
  }

  private async tokenRequest(values: Record<string, string>, refreshToken?: string): Promise<DriveTokens> {
    const body = new URLSearchParams({ client_id: this.options.clientId, ...values });
    if (this.options.clientSecret) body.set('client_secret', this.options.clientSecret);
    let response: Response;
    try { response = await this.request('https://oauth2.googleapis.com/token', { method: 'POST', body, signal: AbortSignal.timeout(30_000) }); }
    catch { throw new DriveError('network', 'Google sign-in is unreachable. Try again when connected.'); }
    const data = await response.json() as any;
    if (!response.ok || !data.access_token) {
      if (data.error === 'invalid_grant') { await this.options.setTokens(undefined); this.cached.clear(); }
      throw new DriveError('auth', data.error === 'invalid_grant' ? 'Google access expired or was revoked. Sign in again.' : 'Google sign-in failed. Check the Desktop OAuth client configuration.');
    }
    const tokens: DriveTokens = { accessToken: data.access_token, refreshToken: data.refresh_token ?? refreshToken, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
    await this.options.setTokens(tokens);
    return tokens;
  }

  async refresh(): Promise<DriveTokens> {
    if (!this.refreshing) this.refreshing = (async () => {
      const tokens = await this.options.getTokens();
      if (!tokens?.refreshToken) throw new DriveError('auth', 'Sign in to Google Drive to continue.');
      return this.tokenRequest({ refresh_token: tokens.refreshToken, grant_type: 'refresh_token' }, tokens.refreshToken);
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async api(url: URL, retried = false): Promise<any> {
    let tokens = await this.options.getTokens();
    if (!tokens) throw new DriveError('auth', 'Sign in to Google Drive to continue.');
    if (tokens.expiresAt <= Date.now() + 60_000) tokens = await this.refresh();
    let response: Response;
    try { response = await this.request(url, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(30_000) }); }
    catch { throw new DriveError('network', 'Google Drive is unreachable. Cached files may be out of date.'); }
    if (response.status === 401 && !retried) { await this.refresh(); return this.api(url, true); }
    if (response.status === 401) { await this.disconnect(); throw new DriveError('auth', 'Google access expired. Sign in again.'); }
    if (response.status === 403 || response.status === 404) throw new DriveError('permission', 'This folder is unavailable or your account does not have access.');
    if (!response.ok) throw new DriveError('api', `Google Drive returned ${response.status}. Try refreshing later.`);
    return response.json();
  }

  async getFile(fileId: string): Promise<DriveFile> {
    if (!/^[A-Za-z0-9_-]+$/.test(fileId)) throw new DriveError('api', 'Enter a valid Google Drive file or folder ID.');
    const url = new URL(`${endpoint}/${encodeURIComponent(fileId)}`);
    url.search = new URLSearchParams({ fields, supportsAllDrives: 'true' }).toString();
    return this.api(url);
  }

  async listFolder(folderId: string, options: ListFolderOptions = {}): Promise<DriveFile[]> {
    const collected: DriveFile[] = [];
    try {
      const root = await this.getFile(folderId);
      if (root.mimeType !== folderMime) throw new DriveError('api', 'The selected Drive item is not a folder.');
      const pending = [{ id: root.id, path: root.name }];
      const visited = new Set<string>();
      while (pending.length) {
        const folder = pending.shift()!;
        if (visited.has(folder.id)) continue;
        visited.add(folder.id);
        let pageToken: string | undefined;
        const tokens = new Set<string>();
        do {
          const url = new URL(endpoint);
          const query = new URLSearchParams({
            q: `'${folder.id.replace(/'/g, "\\'")}' in parents and trashed = false`,
            fields: `nextPageToken,incompleteSearch,files(${fields})`, pageSize: '1000',
            supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
            corpora: root.driveId ? 'drive' : 'user',
          });
          if (root.driveId) query.set('driveId', root.driveId);
          if (pageToken) query.set('pageToken', pageToken);
          url.search = query.toString();
          const result = await this.api(url);
          if (result.incompleteSearch) throw new DriveError('api', 'Google returned an incomplete folder listing. Refresh this folder to try again.');
          const page = (result.files ?? []).map((file: DriveFile) => ({ ...file, path: `${folder.path}/${file.name}` }));
          collected.push(...page);
          options.onPage?.(page);
          if (options.recursive !== false) for (const child of page) {
            if (child.mimeType === folderMime) pending.push({ id: child.id, path: child.path });
          }
          pageToken = result.nextPageToken;
          if (pageToken) {
            if (tokens.has(pageToken)) throw new DriveError('pagination', 'Google repeated a page token. Refresh this folder to try again.');
            tokens.add(pageToken);
          }
        } while (pageToken);
      }
      this.cached.set(folderId, { fetchedAt: new Date().toISOString(), files: collected });
      return collected.filter(file => (!options.query || file.name.toLowerCase().includes(options.query.toLowerCase())) && (!options.mimeType || file.mimeType === options.mimeType));
    } catch (error) {
      if (error instanceof DriveError) { error.partialFiles = collected; throw error; }
      throw new DriveError('api', 'Could not read Google Drive metadata. Try refreshing.', collected);
    }
  }
}
