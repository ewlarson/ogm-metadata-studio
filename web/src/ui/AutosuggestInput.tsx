
import React, { useState, useEffect, useRef } from "react";
import { suggest, SuggestResult } from "../duckdb/duckdbClient";

interface AutosuggestInputProps {
    value: string;
    onChange: (val: string) => void;
    onSearch: (val: string, suggestion?: SuggestResult) => void;
    placeholder?: string;
    className?: string;
}

export const AutosuggestInput: React.FC<AutosuggestInputProps> = ({
    value,
    onChange,
    onSearch,
    placeholder = "Search...",
    className = ""
}) => {
    const [suggestions, setSuggestions] = useState<SuggestResult[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [focusedIndex, setFocusedIndex] = useState(-1);
    const wrapperRef = useRef<HTMLDivElement>(null);

    // Debounce suggestions
    useEffect(() => {
        const timer = setTimeout(async () => {
            if (value.trim().length > 1) { // Min 2 chars
                const results = await suggest(value);
                setSuggestions(results);
                setIsOpen(results.length > 0);
            } else {
                setSuggestions([]);
                setIsOpen(false);
            }
        }, 300);

        return () => clearTimeout(timer);
    }, [value]);

    // Handle outside click
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setFocusedIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : prev));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setFocusedIndex(prev => (prev > -1 ? prev - 1 : prev));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (focusedIndex >= 0 && suggestions[focusedIndex]) {
                selectSuggestion(suggestions[focusedIndex]);
            } else {
                onSearch(value);
                setIsOpen(false);
            }
        } else if (e.key === "Escape") {
            setIsOpen(false);
        }
    };

    const selectSuggestion = (s: SuggestResult) => {
        onChange(s.text);
        onSearch(s.text, s);
        setIsOpen(false);
        setFocusedIndex(-1);
    };

    return (
        <div ref={wrapperRef} className={`relative ${className}`}>
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-slate-400 dark:text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            </div>
            <input
                type="text"
                className="block w-full rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 pl-10 pr-3 py-2 text-slate-900 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:text-sm"
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                    if (suggestions.length > 0) setIsOpen(true);
                }}
            />

            {isOpen && (
                <ul className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md bg-white dark:bg-slate-900 py-1 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm border border-gray-200 dark:border-slate-700">
                    {suggestions.map((suggestion, index) => (
                        <li
                            key={index}
                            className={`relative cursor-default select-none py-2 pl-3 pr-9 ${index === focusedIndex ? "bg-indigo-600 text-white" : "text-slate-900 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800"
                                }`}
                            onClick={() => selectSuggestion(suggestion)}
                            onMouseEnter={() => setFocusedIndex(index)}
                        >
                            <div className="flex justify-between items-center">
                                <span className={`block truncate ${index === focusedIndex ? "font-semibold" : "font-normal"}`}>
                                    {suggestion.text}
                                </span>
                                <span className={`text-xs ml-2 ${index === focusedIndex ? "text-indigo-200" : "text-slate-400"}`}>
                                    {suggestion.type}
                                </span>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};
