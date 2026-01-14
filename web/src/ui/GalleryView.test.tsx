import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GalleryView } from './GalleryView';

const mockObserve = vi.fn();
const mockUnobserve = vi.fn();

class MockIntersectionObserver {
    callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
    }
    observe = (target: Element) => {
        mockObserve(target);
        // Simulate intersection immediately for testing
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as any);
    };
    unobserve = mockUnobserve;
    disconnect = vi.fn();
}

vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

describe('GalleryView', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders list of resources', () => {
        const resources = [
            { id: '1', dct_title_s: 'Title 1', gbl_resourceClass_sm: ['Maps'] },
            { id: '2', dct_title_s: 'Title 2' }
        ];
        const thumbs = { '1': 'img1.png', '2': null };

        render(<GalleryView resources={resources as any} thumbnails={thumbs} />);

        expect(screen.getByText('Title 1')).toBeDefined();
        expect(screen.getByText('Title 2')).toBeDefined();
        const images = screen.getAllByAltText('');
        expect(images[0]).toHaveAttribute('src', 'img1.png');
    });

    it('renders empty state', () => {
        render(<GalleryView resources={[]} thumbnails={{}} />);
        expect(screen.getByText('No results found.')).toBeDefined();
    });

    it('triggers onSelect when clicked', () => {
        const resources = [{ id: '1', dct_title_s: 'Title 1' }];
        const onSelect = vi.fn();

        render(<GalleryView resources={resources as any} thumbnails={{}} onSelect={onSelect} />);

        fireEvent.click(screen.getByText('Title 1'));
        expect(onSelect).toHaveBeenCalledWith('1');
    });

    it('triggers onLoadMore when sentinel intersects', () => {
        const resources = [{ id: '1', dct_title_s: 'Title 1' }];
        const onLoadMore = vi.fn();

        render(<GalleryView
            resources={resources as any}
            thumbnails={{}}
            hasMore={true}
            onLoadMore={onLoadMore}
        />);

        expect(mockObserve).toHaveBeenCalled();
        // Since my mock implementation calls callback immediately on observe:
        expect(onLoadMore).toHaveBeenCalled();
    });

    it('does not observe if hasMore is false', () => {
        const resources = [{ id: '1', dct_title_s: 'Title 1' }];

        render(<GalleryView
            resources={resources as any}
            thumbnails={{}}
            hasMore={false}
        />);

        expect(mockObserve).not.toHaveBeenCalled(); // Sentinel not rendered if hasMore is false?
        // Let's check code: {hasMore && <div ref={observerTarget} ... />}
        // Correct.
    });
});
