/** SmartAPI WebSocket 2.0: 10 best-five records at byte 147, 20 bytes each.
 * Quantity is exchange units. Invalid/empty records are omitted, never inferred from LTP.
 * https://smartapi.angelone.in/docs (Section-2 Best Five Data).
 */
export function snapDepth(packet: Buffer): {
    bid?: number;
    ask?: number;
    bidQty?: number;
    askQty?: number;
    depth?: {
        buy: DepthLevel[];
        sell: DepthLevel[];
    };
} {
    if (packet.length < 379 || packet[0] !== 3)
        return {};
    const buy: DepthLevel[] = [], sell: DepthLevel[] = [];
    for (let i = 0; i < 10; i++) {
        const offset = 147 + i * 20, flag = packet.readInt16LE(offset), qty = Number(packet.readBigInt64LE(offset + 2)), rawPrice = Number(packet.readBigInt64LE(offset + 10)), price = rawPrice / 100, orders = packet.readInt16LE(offset + 18);
        if ((flag !== 0 && flag !== 1) || !Number.isSafeInteger(qty) || qty < 0 || !Number.isSafeInteger(rawPrice) || rawPrice < 0 || orders < 0)
            return {};
        if (qty === 0 || price === 0)
            continue;
        (flag === 1 ? buy : sell).push({ price, quantity: qty, orders });
    }
    buy.sort((a, b) => b.price - a.price);
    sell.sort((a, b) => a.price - b.price);
    // Crossed books may still supply evidence but can never qualify for a fill.
    if (!buy.length || !sell.length || buy[0].price > sell[0].price)
        return {};
    return { bid: buy[0].price, ask: sell[0].price, bidQty: buy[0].quantity, askQty: sell[0].quantity, depth: { buy, sell } };
}
interface DepthLevel {
    price: number;
    quantity: number;
    orders: number;
}
