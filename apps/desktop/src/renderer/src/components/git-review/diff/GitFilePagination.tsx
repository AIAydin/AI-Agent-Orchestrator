import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';

export const GIT_FILE_PAGE_SIZE = 100;

export interface GitFilePage {
  readonly start: number;
  readonly end: number;
  readonly page: number;
  readonly pageCount: number;
  readonly setPage: (page: number) => void;
}

export function useGitFilePage(fileCount: number, selectedIndex: number): GitFilePage {
  const pageCount = Math.max(1, Math.ceil(fileCount / GIT_FILE_PAGE_SIZE));
  const selectedPage = selectedIndex >= 0 ? Math.floor(selectedIndex / GIT_FILE_PAGE_SIZE) : null;
  const [requestedPage, setRequestedPage] = useState(selectedPage ?? 0);
  const page = Math.min(requestedPage, pageCount - 1);

  useEffect(() => {
    setRequestedPage((current) => selectedPage ?? Math.min(current, pageCount - 1));
  }, [pageCount, selectedPage]);

  return {
    start: page * GIT_FILE_PAGE_SIZE,
    end: Math.min(fileCount, (page + 1) * GIT_FILE_PAGE_SIZE),
    page,
    pageCount,
    setPage: (nextPage) => setRequestedPage(Math.max(0, Math.min(nextPage, pageCount - 1))),
  };
}

export function GitFilePageControls({
  label,
  fileCount,
  page: { start, end, page, pageCount, setPage },
}: {
  label: string;
  fileCount: number;
  page: GitFilePage;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="git-file-pagination" role="group" aria-label={`${label} pages`}>
      <button
        type="button"
        aria-label={`Previous ${label.toLowerCase()} page`}
        disabled={page === 0}
        onClick={() => setPage(page - 1)}
      >
        <ChevronLeft size={12} aria-hidden="true" />
      </button>
      <span>
        {start + 1}–{end} of {fileCount}
      </span>
      <button
        type="button"
        aria-label={`Next ${label.toLowerCase()} page`}
        disabled={page === pageCount - 1}
        onClick={() => setPage(page + 1)}
      >
        <ChevronRight size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
