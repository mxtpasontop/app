import { Directory, File, Paths } from 'expo-file-system';
import { createDownloadResumable, type DownloadProgressData } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { trackResourceDownload, uploadUrl } from '@/services/api';
import type { DownloadFile, ResourceDetail } from '@/services/api';
import { useHistoryStore } from '@/stores/history';

const DOWNLOAD_DIRECTORY = 'telechargements';

export interface DownloadProgress {
  bytesWritten: number;
  totalBytes: number;
  /** Between 0 and 1, or `null` when the server sends no Content-Length. */
  ratio: number | null;
}

export type DownloadOutcome =
  | { status: 'saved'; uri: string }
  | { status: 'opened-externally' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/** Resolves the absolute URL a download entry points to. */
export function downloadUrl(file: DownloadFile): string | null {
  return file.externalUrl ?? uploadUrl(file.path);
}

/** Sanitises a file name so it is safe to write on both platforms. */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : 'fichier';
}

function ensureDownloadDirectory(): Directory {
  const directory = new Directory(Paths.document, DOWNLOAD_DIRECTORY);
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

interface DownloadArgs {
  resource: Pick<ResourceDetail, 'id' | 'title' | 'platform' | 'logo'>;
  file: DownloadFile;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

/**
 * Downloads a resource file into the app sandbox, then hands it to the system
 * share sheet so the user can store it wherever they want.
 *
 * External links (GitHub releases, mirrors…) are opened in the browser instead:
 * they are not guaranteed to be direct file URLs.
 */
export async function downloadResourceFile({
  resource,
  file,
  onProgress,
  signal,
}: DownloadArgs): Promise<DownloadOutcome> {
  const url = downloadUrl(file);
  if (!url) return { status: 'error', message: 'Aucun lien de téléchargement.' };

  const recordHistory = (size: number | null) => {
    useHistoryStore.getState().addDownload({
      resourceId: resource.id,
      resourceTitle: resource.title,
      fileName: file.fileName,
      url,
      size,
      version: file.version,
      platform: resource.platform,
      logo: resource.logo,
    });
    void trackResourceDownload(resource.id);
  };

  if (file.externalUrl || Platform.OS === 'web') {
    await WebBrowser.openBrowserAsync(url);
    recordHistory(file.sizeBytes);
    return { status: 'opened-externally' };
  }

  try {
    const destination = new File(
      ensureDownloadDirectory(),
      safeFileName(file.fileName)
    );

    // expo-file-system's modern File.downloadFileAsync has no progress/abort
    // support on this SDK line, so the legacy resumable API drives the actual
    // transfer; the resulting file is then wrapped back into a modern `File`.
    const resumable = createDownloadResumable(
      url,
      destination.uri,
      // The legacy download API always overwrites the destination, matching
      // the modern API's `idempotent: true` behaviour used previously.
      {},
      ({ totalBytesWritten, totalBytesExpectedToWrite }: DownloadProgressData) =>
        onProgress?.({
          bytesWritten: totalBytesWritten,
          totalBytes: totalBytesExpectedToWrite,
          ratio:
            totalBytesExpectedToWrite > 0
              ? Math.min(1, totalBytesWritten / totalBytesExpectedToWrite)
              : null,
        })
    );

    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      void resumable.pauseAsync();
    };
    signal?.addEventListener('abort', onAbort);

    let result;
    try {
      result = await resumable.downloadAsync();
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (!result || cancelled) {
      try {
        if (destination.exists) destination.delete();
      } catch {
        // Best-effort cleanup of a partial file; a stray temp file is
        // harmless and will be cleared by clearDownloadedFiles() later.
      }
      return { status: 'cancelled' };
    }

    const downloaded = new File(result.uri);
    recordHistory(downloaded.exists ? downloaded.size : file.sizeBytes);

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(downloaded.uri, {
        dialogTitle: `Enregistrer ${file.fileName}`,
      });
    }

    return { status: 'saved', uri: downloaded.uri };
  } catch (error) {
    if (signal?.aborted) {
      return { status: 'cancelled' };
    }
    return { status: 'error', message: (error as Error).message };
  }
}

/** Removes every file previously downloaded by the app. */
export function clearDownloadedFiles(): void {
  if (Platform.OS === 'web') return;
  try {
    const directory = new Directory(Paths.document, DOWNLOAD_DIRECTORY);
    if (directory.exists) directory.delete();
  } catch {
    // Nothing to clean up if the sandbox is unavailable.
  }
}

/** Total size on disk of the downloads folder, in bytes. */
export function downloadedBytes(): number {
  if (Platform.OS === 'web') return 0;
  try {
    const directory = new Directory(Paths.document, DOWNLOAD_DIRECTORY);
    if (!directory.exists) return 0;
    return directory
      .list()
      .reduce((total, entry) => total + (entry instanceof File ? (entry.size ?? 0) : 0), 0);
  } catch {
    return 0;
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes <= 0) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}
