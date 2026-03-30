import { Exchange, type Orderbook, type OrdersMatchedGlobal } from "generated";
import {
  parseOrderFilled,
  updateUserPositionWithBuy,
  updateUserPositionWithSell,
} from "../utils/pnl.js";
import { COLLATERAL_SCALE } from "../utils/constants.js";
import { getMarketMetadata } from "../effects/marketMetadata.js";

const TRADE_TYPE_BUY = "Buy";
const TRADE_TYPE_SELL = "Sell";
const COLLATERAL_SCALE_DEC = 1_000_000;

function getOrderSide(makerAssetId: bigint): string {
  return makerAssetId === 0n ? TRADE_TYPE_BUY : TRADE_TYPE_SELL;
}

function getOrderSize(
  makerAmountFilled: bigint,
  takerAmountFilled: bigint,
  side: string,
): bigint {
  return side === TRADE_TYPE_BUY ? makerAmountFilled : takerAmountFilled;
}

function scaleBigInt(value: bigint): number {
  return Number(value) / COLLATERAL_SCALE_DEC;
}

async function getOrCreateOrderbook(
  context: any,
  tokenId: string,
): Promise<Orderbook> {
  const existing = await context.Orderbook.get(tokenId);
  if (existing) return existing;
  return {
    id: tokenId,
    tradesQuantity: 0n,
    buysQuantity: 0n,
    sellsQuantity: 0n,
    collateralVolume: 0n,
    scaledCollateralVolume: 0,
    collateralBuyVolume: 0n,
    scaledCollateralBuyVolume: 0,
    collateralSellVolume: 0n,
    scaledCollateralSellVolume: 0,
    blockNumber: 0n,
    blockTimestamp: 0n,
  };
}

async function getOrCreateGlobal(
  context: any,
): Promise<OrdersMatchedGlobal> {
  const existing = await context.OrdersMatchedGlobal.get("");
  if (existing) return existing;
  return {
    id: "",
    tradesQuantity: 0n,
    buysQuantity: 0n,
    sellsQuantity: 0n,
    collateralVolume: 0n,
    scaledCollateralVolume: 0,
    collateralBuyVolume: 0n,
    scaledCollateralBuyVolume: 0,
    collateralSellVolume: 0n,
    scaledCollateralSellVolume: 0,
    blockNumber: 0n,
    blockTimestamp: 0n,
  };
}

// ============================================================
// OrderFilled — individual order fill records + orderbook updates
// ============================================================

Exchange.OrderFilled.handler(async ({ event, context }) => {
  const makerAssetId = event.params.makerAssetId;
  const takerAssetId = event.params.takerAssetId;
  const side = getOrderSide(makerAssetId);
  const size = getOrderSize(
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    side,
  );

  const tokenId =
    side === TRADE_TYPE_BUY ? takerAssetId.toString() : makerAssetId.toString();

  // Record OrderFilledEvent
  const eventId = `${event.chainId}_${event.block.number}_${event.logIndex}`;
  context.OrderFilledEvent.set({
    id: eventId,
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    orderHash: event.params.orderHash,
    maker: event.params.maker,
    taker: event.params.taker,
    makerAssetId: makerAssetId.toString(),
    takerAssetId: takerAssetId.toString(),
    makerAmountFilled: event.params.makerAmountFilled,
    takerAmountFilled: event.params.takerAmountFilled,
    fee: event.params.fee,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
  });

  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

  // Update Orderbook
  const orderbook = await getOrCreateOrderbook(context, tokenId);
  const newVolume = orderbook.collateralVolume + size;

  if (side === TRADE_TYPE_BUY) {
    const newBuyVol = orderbook.collateralBuyVolume + size;
    context.Orderbook.set({
      ...orderbook,
      collateralVolume: newVolume,
      scaledCollateralVolume: scaleBigInt(newVolume),
      tradesQuantity: orderbook.tradesQuantity + 1n,
      buysQuantity: orderbook.buysQuantity + 1n,
      collateralBuyVolume: newBuyVol,
      scaledCollateralBuyVolume: scaleBigInt(newBuyVol),
      blockNumber,
      blockTimestamp,
    });
  } else {
    const newSellVol = orderbook.collateralSellVolume + size;
    context.Orderbook.set({
      ...orderbook,
      collateralVolume: newVolume,
      scaledCollateralVolume: scaleBigInt(newVolume),
      tradesQuantity: orderbook.tradesQuantity + 1n,
      sellsQuantity: orderbook.sellsQuantity + 1n,
      collateralSellVolume: newSellVol,
      scaledCollateralSellVolume: scaleBigInt(newSellVol),
      blockNumber,
      blockTimestamp,
    });
  }

  // PnL: Update user position based on order fill
  const order = parseOrderFilled(event.params);
  const price =
    order.baseAmount > 0n
      ? (order.quoteAmount * COLLATERAL_SCALE) / order.baseAmount
      : 0n;

  if (order.side === "BUY") {
    await updateUserPositionWithBuy(
      context,
      order.account,
      order.positionId,
      price,
      order.baseAmount,
      blockNumber,
      blockTimestamp,
    );
  } else {
    await updateUserPositionWithSell(
      context,
      order.account,
      order.positionId,
      price,
      order.baseAmount,
      blockNumber,
      blockTimestamp,
    );
  }
});

// ============================================================
// OrdersMatched — batch match records + global volume
// ============================================================

Exchange.OrdersMatched.handler(async ({ event, context }) => {
  // Note: In the original subgraph, amounts are swapped for OrdersMatched
  const makerAmountFilled = event.params.takerAmountFilled;
  const takerAmountFilled = event.params.makerAmountFilled;
  const side = getOrderSide(event.params.makerAssetId);
  const size = getOrderSize(makerAmountFilled, takerAmountFilled, side);

  // Record OrdersMatchedEvent
  context.OrdersMatchedEvent.set({
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    timestamp: BigInt(event.block.timestamp),
    makerAssetID: event.params.makerAssetId,
    takerAssetID: event.params.takerAssetId,
    makerAmountFilled: event.params.makerAmountFilled,
    takerAmountFilled: event.params.takerAmountFilled,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
  });

  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

  // Update global volume
  const global = await getOrCreateGlobal(context);
  const newVolume = global.collateralVolume + size;

  if (side === TRADE_TYPE_BUY) {
    const newBuyVol = global.collateralBuyVolume + size;
    context.OrdersMatchedGlobal.set({
      ...global,
      tradesQuantity: global.tradesQuantity + 1n,
      collateralVolume: newVolume,
      scaledCollateralVolume: scaleBigInt(newVolume),
      buysQuantity: global.buysQuantity + 1n,
      collateralBuyVolume: newBuyVol,
      scaledCollateralBuyVolume: scaleBigInt(newBuyVol),
      blockNumber,
      blockTimestamp,
    });
  } else {
    const newSellVol = global.collateralSellVolume + size;
    context.OrdersMatchedGlobal.set({
      ...global,
      tradesQuantity: global.tradesQuantity + 1n,
      collateralVolume: newVolume,
      scaledCollateralVolume: scaleBigInt(newVolume),
      sellsQuantity: global.sellsQuantity + 1n,
      collateralSellVolume: newSellVol,
      scaledCollateralSellVolume: scaleBigInt(newSellVol),
      blockNumber,
      blockTimestamp,
    });
  }
});

// ============================================================
// TokenRegistered — link token IDs to conditions
// ============================================================

Exchange.TokenRegistered.handler(async ({ event, context }) => {
  const token0Str = event.params.token0.toString();
  const token1Str = event.params.token1.toString();
  const condition = event.params.conditionId;
  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

  // Fetch market metadata from Polymarket Gamma API (cached + rate-limited)
  const metadata = await context.effect(getMarketMetadata, token0Str);
  const marketName = metadata?.question ?? "";
  const marketSlug = metadata?.slug ?? "";
  const outcomes = metadata?.outcomes ?? "[]";
  const description = metadata?.description ?? "";
  const image = metadata?.image ?? "";
  const startDate = metadata?.startDate ?? "";
  const endDate = metadata?.endDate ?? "";

  const data0 = await context.MarketData.get(token0Str);
  if (!data0) {
    context.MarketData.set({
      id: token0Str,
      condition,
      outcomeIndex: undefined,
      marketName,
      marketSlug,
      outcomes,
      description,
      image,
      startDate,
      endDate,
      blockNumber,
      blockTimestamp,
    });
  }

  const data1 = await context.MarketData.get(token1Str);
  if (!data1) {
    context.MarketData.set({
      id: token1Str,
      condition,
      outcomeIndex: undefined,
      marketName,
      marketSlug,
      outcomes,
      description,
      image,
      startDate,
      endDate,
      blockNumber,
      blockTimestamp,
    });
  }
});
