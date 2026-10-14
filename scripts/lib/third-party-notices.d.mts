export interface NoticeEntry {
  name: string;
  version: string;
  license: string;
  author: string;
  repository: string;
  texts: { file: string; text: string }[];
}
export function packageDirOf(file: string): string | null;
export function packageDirsOf(files: Iterable<string>, base?: string): string[];
export function noticeEntries(dirs: Iterable<string>): NoticeEntry[];
export function renderNotices(dirs: Iterable<string>, options: { product: string }): string;
