import { FeeModule } from "generated";
import { NEG_RISK_FEE_MODULE } from "../utils/constants.js";

FeeModule.FeeRefunded.handler(async ({ event, context }) => {
  const negRisk =
    event.srcAddress.toLowerCase() === NEG_RISK_FEE_MODULE.toLowerCase();

  context.FeeRefunded.set({
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
    logIndex: event.logIndex,
    transactionHash: event.transaction.hash,
    orderHash: event.params.orderHash,
    tokenId: event.params.id.toString(),
    timestamp: BigInt(event.block.timestamp),
    refundee: event.params.to,
    feeRefunded: event.params.refund,
    feeCharged: event.params.feeCharged,
    negRisk,
  });
});

FeeModule.FeeWithdrawn.handler(async ({ event, context }) => {
  context.FeeWithdrawn.set({
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
    logIndex: event.logIndex,
    transactionHash: event.transaction.hash,
    token: event.params.token,
    to: event.params.to,
    tokenId: event.params.id.toString(),
    amount: event.params.amount,
  });
});
