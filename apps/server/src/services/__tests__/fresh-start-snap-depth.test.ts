import { describe, it, expect } from 'vitest';
import { snapDepth } from '../../providers/angel-one/snap-depth.js';
function packet() {
    const b = Buffer.alloc(379);
    b[0] = 3;
    for (let i = 0; i < 10; i++) {
        const j = 147 + i * 20;
        b.writeInt16LE(i < 5 ? 1 : 0, j);
        b.writeBigInt64LE(BigInt(75 + i), j + 2);
        b.writeBigInt64LE(BigInt(i < 5 ? 10000 - i * 5 : 10005 + (i - 5) * 5), j + 10);
        b.writeInt16LE(2, j + 18);
    }
    return b;
}
describe('observed SmartAPI best-five depth', () => {
    it('decodes exchange units and prices at documented offsets, independently of LTP', () => { const p = packet(); p.writeBigInt64LE(999999n, 43); expect(snapDepth(p)).toMatchObject({ bid: 100, ask: 100.05, bidQty: 75, askQty: 80 }); expect(snapDepth(p).depth?.buy).toHaveLength(5); });
    it('does not guess a book from truncated/LTP/empty packets or unsafe quantities', () => {
        expect(snapDepth(packet().subarray(0, 378))).toEqual({});
        const p = packet();
        p[0] = 1;
        expect(snapDepth(p)).toEqual({});
        const empty = Buffer.alloc(379);
        empty[0] = 3;
        expect(snapDepth(empty)).toEqual({});
        const unsafe = packet();
        for (let i = 0; i < 5; i++)
            unsafe.writeBigInt64LE(9223372036854775807n, 149 + i * 20);
        expect(snapDepth(unsafe)).toEqual({});
    });
    it('rejects crossed books and sorts valid records without trusting wire order', () => { const p = packet(); p.writeBigInt64LE(10100n, 157); expect(snapDepth(p)).toEqual({}); const sorted = packet(); sorted.writeBigInt64LE(9999n, 157); sorted.writeBigInt64LE(10000n, 177); expect(snapDepth(sorted)).toMatchObject({ bid: 100, bidQty: 76 }); });
});
