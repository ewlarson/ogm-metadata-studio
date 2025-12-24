import React, { useMemo } from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, Tooltip, Brush } from "recharts";

interface TimelineFacetProps {
    data: { value: string; count: number }[];
    range?: [number, number];
    onChange: (range: [number, number] | undefined) => void;
}

export const TimelineFacet: React.FC<TimelineFacetProps> = ({ data, range, onChange }) => {

    const chartData = useMemo(() => {
        // Parse years and sort
        const parsed = data
            .map(d => ({ year: parseInt(d.value, 10), count: d.count }))
            .filter(d => !isNaN(d.year))
            .sort((a, b) => a.year - b.year);
        return parsed;
    }, [data]);

    // Debounce reference
    const debounceRef = React.useRef<NodeJS.Timeout>();

    if (chartData.length === 0) return null;

    // Handle Brush change
    // Recharts Brush `onChange` returns { startIndex, endIndex } indices.
    // We need to map back to years.
    // Actually, Recharts Brush on a categorical/number axis might behave differently.
    // If we use index-based brush, it's easier to map back.

    const handleBrushChange = (e: any) => {
        if (!e || e.startIndex === undefined || e.endIndex === undefined) return;

        // Map index to year
        const startYear = chartData[e.startIndex]?.year;
        const endYear = chartData[e.endIndex]?.year;

        if (startYear !== undefined && endYear !== undefined) {
            // Clear existing timeout
            if (debounceRef.current) clearTimeout(debounceRef.current);

            // Set new timeout (500ms)
            debounceRef.current = setTimeout(() => {
                // Only update if differ from current
                if (!range || range[0] !== startYear || range[1] !== endYear) {
                    onChange([startYear, endYear]);
                }
            }, 500);
        }
    };

    // Calculate initial indices for Brush based on prop range
    let startIndex = 0;
    let endIndex = chartData.length - 1;

    if (range) {
        const s = chartData.findIndex(d => d.year >= range[0]);
        const e = [...chartData].reverse().findIndex(d => d.year <= range[1]);
        if (s !== -1) startIndex = s;
        if (e !== -1) endIndex = chartData.length - 1 - e;
    }

    return (
        <div className="w-full h-40 mb-4 bg-white dark:bg-slate-900 rounded border border-gray-200 dark:border-slate-800 p-2">
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wider flex justify-between">
                <span>Year Distribution</span>
                {range && (
                    <button
                        onClick={() => onChange(undefined)}
                        className="text-primary hover:underline text-[10px]"
                    >
                        Reset ({range[0]} - {range[1]})
                    </button>
                )}
            </div>

            <div className="h-28">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                        <XAxis
                            dataKey="year"
                            fontSize={10}
                            tickLine={false}
                            axisLine={false}
                            minTickGap={30}
                        />
                        <Tooltip
                            contentStyle={{ fontSize: '12px', padding: '4px', borderRadius: '4px' }}
                            labelStyle={{ fontWeight: 'bold' }}
                            cursor={{ fill: 'rgba(0,0,0,0.05)' }}
                        />
                        <Bar
                            dataKey="count"
                            fill="#3b82f6"
                            radius={[2, 2, 0, 0]}
                            animationDuration={300}
                            className="cursor-pointer hover:opacity-80 transition-opacity"
                            onClick={(data: any) => {
                                if (data && data.year) {
                                    onChange([data.year, data.year]);
                                } else if (data && data.payload && data.payload.year) {
                                    onChange([data.payload.year, data.payload.year]);
                                }
                            }}
                        />

                        <Brush
                            height={20}
                            stroke="#94a3b8"
                            travellerWidth={10}
                            startIndex={startIndex}
                            endIndex={endIndex}
                            onChange={handleBrushChange}
                            alwaysShowText={false}
                            fill="#f1f5f9"
                        />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};
