import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TimelineFacet } from './TimelineFacet';

// Mock Recharts
// We need to capture the props passed to Brush to trigger onChange manually
const MockBrush = ({ onChange, startIndex, endIndex }: any) => (
    <div data-testid="brush">
        Brush Range: {startIndex}-{endIndex}
        <button
            data-testid="trigger-brush"
            onClick={() => onChange({ startIndex: 0, endIndex: 1 })}
        >
            Trigger
        </button>
    </div>
);

vi.mock('recharts', () => ({
    ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
    BarChart: ({ children }: any) => <div>BarChart {children}</div>,
    Bar: () => <div>Bar</div>,
    XAxis: () => <div>XAxis</div>,
    Tooltip: () => <div>Tooltip</div>,
    Brush: (props: any) => MockBrush(props)
}));

describe('TimelineFacet', () => {
    const mockData = [
        { value: '2000', count: 10 },
        { value: '2001', count: 5 },
        { value: '2002', count: 8 }
    ];

    it('renders nothing if no data', () => {
        const { container } = render(<TimelineFacet data={[]} onChange={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders chart with data', () => {
        render(<TimelineFacet data={mockData} onChange={vi.fn()} />);
        expect(screen.getByText('Year Distribution')).toBeDefined();
        expect(screen.getByText('BarChart')).toBeDefined();
    });

    it('handles brush change with debounce', async () => {
        const onChange = vi.fn();
        render(<TimelineFacet data={mockData} onChange={onChange} />);

        // Chart data sorted: 2000, 2001, 2002
        // Indices: 0, 1, 2

        // Find the trigger button from our mock
        const btn = screen.getByTestId('trigger-brush');

        // Mock triggers startIndex:0 (2000), endIndex:1 (2001)
        fireEvent.click(btn);

        // Should not be called immediately (debounce 500ms)
        expect(onChange).not.toHaveBeenCalled();

        // Wait for debounce
        await new Promise(r => setTimeout(r, 600));

        expect(onChange).toHaveBeenCalledWith([2000, 2001]);
    });

    it('renders reset button when range provided', () => {
        const onChange = vi.fn();
        render(<TimelineFacet data={mockData} range={[2000, 2001]} onChange={onChange} />);

        const resetBtn = screen.getByText('Reset (2000 - 2001)');
        expect(resetBtn).toBeDefined();

        fireEvent.click(resetBtn);
        expect(onChange).toHaveBeenCalledWith(undefined);
    });
});
