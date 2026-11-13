import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PagePreview } from './Preview';
import { usePageStore } from '../../store';

vi.mock('../../store', () => ({
  usePageStore: vi.fn(),
}));

const mockFetchPage = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (usePageStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
    selector({ fetchPage: mockFetchPage })
  );
});

describe('PagePreview', () => {
  it('shows loading state initially', () => {
    mockFetchPage.mockImplementation(() => new Promise(() => {}));

    render(<PagePreview pageId="page_1" />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('displays page info when loaded', async () => {
    const mockPage = {
      id: 'page_1',
      title: 'Test Page',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'This is the content of the test page.' }],
          },
        ],
      },
      updatedAt: new Date('2025-12-01'),
      createdAt: new Date('2025-11-01'),
    };

    mockFetchPage.mockResolvedValue(mockPage);

    render(<PagePreview pageId="page_1" />);

    await waitFor(() => {
      expect(screen.getByText('Test Page')).toBeInTheDocument();
    });

    expect(screen.getByText('This is the content of the test page.')).toBeInTheDocument();
    expect(screen.getByText('Click to open')).toBeInTheDocument();
  });

  it('shows not found state for missing page', async () => {
    mockFetchPage.mockResolvedValue(null);

    render(<PagePreview pageId="nonexistent" />);

    await waitFor(() => {
      expect(screen.getByText('Page not found')).toBeInTheDocument();
    });
  });

  it('shows error state on fetch failure', async () => {
    mockFetchPage.mockRejectedValue(new Error('Network error'));

    render(<PagePreview pageId="page_1" />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load page')).toBeInTheDocument();
    });
  });

  it('truncates long excerpts', async () => {
    const longText = 'A'.repeat(300);
    const mockPage = {
      id: 'page_1',
      title: 'Long Page',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: longText }] }],
      },
      updatedAt: new Date(),
      createdAt: new Date(),
    };

    mockFetchPage.mockResolvedValue(mockPage);

    render(<PagePreview pageId="page_1" />);

    await waitFor(() => {
      expect(screen.getByText('Long Page')).toBeInTheDocument();
    });

    const excerpt = screen.getByText(/A+\.\.\./);
    expect(excerpt).toBeInTheDocument();
  });

  it('shows "No content" for empty content', async () => {
    const mockPage = {
      id: 'page_1',
      title: 'Empty Page',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
      updatedAt: new Date(),
      createdAt: new Date(),
    };

    mockFetchPage.mockResolvedValue(mockPage);

    render(<PagePreview pageId="page_1" />);

    await waitFor(() => {
      expect(screen.getByText('No content')).toBeInTheDocument();
    });
  });

  it('formats relative dates correctly', async () => {
    const today = new Date();
    const mockPage = {
      id: 'page_1',
      title: 'Recent Page',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Content' }] }],
      },
      updatedAt: today,
      createdAt: today,
    };

    mockFetchPage.mockResolvedValue(mockPage);

    render(<PagePreview pageId="page_1" />);

    await waitFor(() => {
      expect(screen.getByText(/Updated Today/)).toBeInTheDocument();
    });
  });
});
