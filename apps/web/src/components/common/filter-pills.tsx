'use client';

import React from 'react';

export function FilterPills<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {label && (
        <span className="text-xs font-bold text-gray-400 light:text-slate-600 uppercase tracking-wider whitespace-nowrap">
          {label}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1 bg-gray-900/60 light:bg-slate-100 border border-gray-800/60 light:border-slate-200 rounded-lg p-1">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            aria-pressed={value === opt.value}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${
              value === opt.value
                ? 'bg-emerald-500 text-black shadow-[0_1px_4px_rgba(16,185,129,0.5)]'
                : 'text-gray-400 light:text-slate-600 hover:bg-gray-800 light:hover:bg-slate-200 hover:text-gray-200 light:hover:text-slate-800'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
