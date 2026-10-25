import type { ISeriesPrimitive, ISeriesPrimitivePaneView, ISeriesPrimitivePaneRenderer, SeriesAttachedParameter, Time, UTCTimestamp } from 'lightweight-charts';
import type { ChartZone } from './chart-zones';

/** Native chart primitive: redraws with time/price scale changes, zoom, pan and resize. */
export class ChartZonePrimitive implements ISeriesPrimitive<Time> {
  private attachedTo: SeriesAttachedParameter<Time> | null = null;
  private zones: readonly ChartZone[] = [];
  private light = false;
  private readonly renderer: ISeriesPrimitivePaneRenderer = {
    draw: (target) => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this.attachedTo) return;
      const { chart, series } = this.attachedTo;
      const width = mediaSize.width;
      const height = mediaSize.height;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
      for (const z of [...this.zones].reverse()) {
        const x = chart.timeScale().timeToCoordinate(z.start as UTCTimestamp);
        const end = z.active ? width : chart.timeScale().timeToCoordinate(z.end as UTCTimestamp);
        const top = series.priceToCoordinate(z.top);
        const bottom = series.priceToCoordinate(z.bottom);
        if (x == null || end == null || top == null || bottom == null) continue;
        const left = Math.max(0, x), right = Math.min(width, end);
        if (right <= left || bottom < 0 || top > height) continue;
        const color = z.kind === 'FVG' ? (this.light ? '#6d28d9' : '#c4b5fd') : z.direction === 'BULLISH' ? (this.light ? '#087568' : '#26dfcc') : (this.light ? '#b91c1c' : '#fb7185');
        ctx.fillStyle = color + (z.active ? '22' : '0c');
        ctx.fillRect(left, top, right - left, Math.max(1, bottom - top));
        ctx.strokeStyle = color + (z.active ? 'aa' : '55');
        ctx.lineWidth = 1; ctx.setLineDash(z.kind === 'FVG' ? [4, 3] : []);
        ctx.strokeRect(left, top, right - left, Math.max(1, bottom - top));
        ctx.setLineDash([]);
        if (right - left > 90 && bottom - top > 12) {
          ctx.save(); ctx.beginPath(); ctx.rect(left, Math.max(0, top), right - left, Math.min(height, bottom) - Math.max(0, top)); ctx.clip();
          ctx.font = '11px sans-serif'; ctx.fillStyle = color;
          ctx.fillText(`${z.kind} ${z.direction === 'BULLISH' ? 'demand' : 'supply'}${z.active ? '' : ' · ended'}`, left + 6, Math.max(0, top) + 12);
          ctx.restore();
        }
      }
      ctx.restore();
    }),
  };
  private readonly views: ISeriesPrimitivePaneView[] = [{ zOrder: () => 'bottom', renderer: () => this.renderer }];
  attached(parameters: SeriesAttachedParameter<Time>) { this.attachedTo = parameters; }
  detached() { this.attachedTo = null; }
  paneViews() { return this.views; }
  setZones(zones: readonly ChartZone[], light: boolean) { this.zones = zones; this.light = light; this.attachedTo?.requestUpdate(); }
}
