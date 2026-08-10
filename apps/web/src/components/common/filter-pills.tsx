'use client';

import React from 'react';

export function FilterPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 bg-gray-900/40 light:bg-slate-100 border border-gray-800/50 light:border-slate-200 rounded-full p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1 rounded-full text-[10px] font-medium whitespace-nowrap transition-colors ${
            value === opt.value
              ? 'bg-emerald-500/20 light:bg-emerald-500/15 text-emerald-400 light:text-emerald-700 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.35)]'
              : 'text-gray-400 light:text-slate-500 hover:bg-gray-800/60 light:hover:bg-slate-200/70'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
