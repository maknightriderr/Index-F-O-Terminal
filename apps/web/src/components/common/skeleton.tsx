'use client';

import React from 'react';

// ============================================================
// SKELETON LOADERS
// ============================================================
// Shimmer-animated placeholder components that match the
// terminal's dark/light theme. Used across Dashboard, Asset
// Workspace, and scanner pages during initial data fetch.
// ============================================================

interface SkeletonProps {
  className?: string;
  /** Width — any CSS value */
  width?: string;
  /** Height — any CSS value */
  height?: string;
}

/** Basic skeleton rectangle with shimmer animation. */
export function Skeleton({ className = '', width, height }: SkeletonProps) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{ width, height }}
    />
  );
}

/** A card-shaped skeleton matching the terminal card style. */
export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl p-4 space-y-3 ${className}`}>
      <div className="flex items-center justify-between">
        <Skeleton width="80px" height="12px" />
        <Skeleton width="48px" height="18px" className="rounded-md" />
      </div>
      <Skeleton width="120px" height="28px" />
      <Skeleton width="100%" height="8px" />
      <div className="flex justify-between">
        <Skeleton width="60px" height="10px" />
        <Skeleton width="60px" height="10px" />
      </div>
    </div>
  );
}

/** A table row skeleton for scanner/data tables. */
export function SkeletonTableRow({ cols = 8, className = '' }: { cols?: number; className?: string }) {
  return (
    <tr className={`border-t border-gray-800/30 light:border-slate-200 ${className}`}>
      {Array.from({ length: cols }, (_, i) => (
        <td key={i} className="px-3 py-2.5">
          <Skeleton width={i === 0 ? '80px' : '48px'} height="12px" />
        </td>
      ))}
    </tr>
  );
}

/** Multiple skeleton rows for loading table states. */
export function SkeletonTable({ rows = 5, cols = 8 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonTableRow
          key={i}
          cols={cols}
        />
      ))}
    </>
  );
}

/** An intelligence card skeleton. */
export function SkeletonIntelCard({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 border-t-2 border-t-gray-700/30 rounded-xl p-4 space-y-3 ${className}`}>
      <div className="flex items-center justify-between">
        <Skeleton width="100px" height="10px" />
        <Skeleton width="50px" height="18px" className="rounded-md" />
      </div>
      <div className="space-y-2">
        <Skeleton width="100%" height="8px" />
        <Skeleton width="80%" height="8px" />
        <Skeleton width="90%" height="8px" />
      </div>
    </div>
  );
}
