import { ConditionalTokens } from "generated";
import {
  USDC,
  NEG_RISK_ADAPTER,
  EXCHANGE,
  NEG_RISK_EXCHANGE,
  COLLATERAL_SCALE,
  FIFTY_CENTS,
} from "../utils/constants.js";
import { computePositionId } from "../utils/ctf.js";
import { getEventKey } from "../utils/negRisk.js";
import {
  updateUserPositionWithBuy,
  updateUserPositionWithSell,
  loadOrCreateUserPosition,
} from "../utils/pnl.js";

const USDC_LOWER = USDC.toLowerCase();
const NEG_RISK_ADAPTER_LOWER = NEG_RISK_ADAPTER.toLowerCase();
const EXCHANGE_LOWER = EXCHANGE.toLowerCase();
const NEG_RISK_EXCHANGE_LOWER = NEG_RISK_EXCHANGE.toLowerCase();
const NEG_RISK_WRAPPED = "0x3A3BD7bb9528E159577F7C2e685CC81A765002E2" as `0x${string}`;
const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";

// Addresses to skip for activity tracking (handled elsewhere)
const SKIP_ACTIVITY = new Set([
  NEG_RISK_ADAPTER_LOWER,
  EXCHANGE_LOWER,
  NEG_RISK_EXCHANGE_LOWER,
]);

// Skip PnL for these (handled in their own handlers)
const SKIP_PNL = new Set([
  NEG_RISK_ADAPTER_LOWER,
  EXCHANGE_LOWER,
  NEG_RISK_EXCHANGE_LOWER,
]);

// ============================================================
// Helper: get or create OI entities
// ============================================================

async function getOrCreateMarketOI(
  context: any,
  conditionId: string,
): Promise<{ id: string; amount: bigint; blockNumber: bigint; blockTimestamp: bigint }> {
  const existing = await context.MarketOpenInterest.get(conditionId);
  if (existing) return existing;
  return { id: conditionId, amount: 0n, blockNumber: 0n, blockTimestamp: 0n };
}

async function getOrCreateGlobalOI(
  context: any,
): Promise<{ id: string; amount: bigint; blockNumber: bigint; blockTimestamp: bigint }> {
  const existing = await context.GlobalOpenInterest.get("");
  if (existing) return existing;
  return { id: "", amount: 0n, blockNumber: 0n, blockTimestamp: 0n };
}

async function updateOpenInterest(
  context: any,
  conditionId: string,
  amount: bigint,
  blockNumber: bigint,
  blockTimestamp: bigint,
): Promise<void> {
  const marketOI = await getOrCreateMarketOI(context, conditionId);
  context.MarketOpenInterest.set({
    ...marketOI,
    blockNumber,
    blockTimestamp,
    amount: marketOI.amount + amount,
  });

  const globalOI = await getOrCreateGlobalOI(context);
  context.GlobalOpenInterest.set({
    ...globalOI,
    blockNumber,
    blockTimestamp,
    amount: globalOI.amount + amount,
  });
}

// ============================================================
// Helper: compute position IDs for a condition
// ============================================================

function getPositionIds(
  conditionId: `0x${string}`,
  negRisk: boolean,
): [bigint, bigint] {
  const collateral = negRisk ? NEG_RISK_WRAPPED : (USDC as `0x${string}`);
  return [
    computePositionId(collateral, conditionId, 0),
    computePositionId(collateral, conditionId, 1),
  ];
}

// ============================================================
// ConditionPreparation — create Condition + Position entities
// ============================================================

ConditionalTokens.ConditionPreparation.handler(async ({ event, context }) => {
  // Only handle binary conditions (2 outcomes)
  if (event.params.outcomeSlotCount !== 2n) return;

  const conditionId = event.params.conditionId;
  const negRisk =
    event.params.oracle.toLowerCase() === NEG_RISK_ADAPTER_LOWER;
  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

  // Compute position IDs for PnL tracking
  const [posId0, posId1] = getPositionIds(conditionId as `0x${string}`, negRisk);

  // Create Condition entity with position IDs (OI + PnL)
  const existing = await context.Condition.get(conditionId);
  if (!existing) {
    context.Condition.set({
      id: conditionId,
      blockNumber,
      blockTimestamp,
      positionIds: [posId0, posId1],
      payoutNumerators: [] as bigint[],
      payoutDenominator: 0n,
    });
  }

  // Create Position entities (Activity)
  for (let outcomeIndex = 0; outcomeIndex < 2; outcomeIndex++) {
    const positionId = outcomeIndex === 0 ? posId0 : posId1;
    const posIdStr = positionId.toString();

    const existingPos = await context.Position.get(posIdStr);
    if (!existingPos) {
      context.Position.set({
        id: posIdStr,
        condition: conditionId,
        outcomeIndex: BigInt(outcomeIndex),
      });
    }
  }
});

// ============================================================
// ConditionResolution — store payout numerators/denominator (PnL)
// ============================================================

ConditionalTokens.ConditionResolution.handler(async ({ event, context }) => {
  const conditionId = event.params.conditionId;
  const condition = await context.Condition.get(conditionId);
  if (!condition) return;

  const payoutNumerators = event.params.payoutNumerators.map((v: bigint) => v);
  const payoutDenominator = payoutNumerators.reduce(
    (sum: bigint, v: bigint) => sum + v,
    0n,
  );

  context.Condition.set({
    ...condition,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
    payoutNumerators,
    payoutDenominator,
  });
});

// ============================================================
// PositionSplit — Activity + OI + PnL
// ============================================================

ConditionalTokens.PositionSplit.handler(async ({ event, context }) => {
  const conditionId = event.params.conditionId;
  const stakeholder = event.params.stakeholder;
  const stakeholderLower = stakeholder.toLowerCase();
  const collateralToken = event.params.collateralToken;
  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

  const condition = await context.Condition.get(conditionId);
  if (!condition) return;

  // Activity: Create Split (skip FPMMs, NegRiskAdapter, Exchange)
  if (!SKIP_ACTIVITY.has(stakeholderLower)) {
    const isFPMM = await context.FixedProductMarketMaker.get(stakeholder);
    if (!isFPMM) {
      context.Split.set({
        id: getEventKey(event.chainId, event.block.number, event.logIndex),
        blockNumber,
        blockTimestamp,
        logIndex: event.logIndex,
        transactionHash: event.transaction.hash,
        timestamp: blockTimestamp,
        stakeholder,
        condition: conditionId,
        amount: event.params.amount,
      });
    }
  }

  // OI: Only track USDC splits
  if (collateralToken.toLowerCase() === USDC_LOWER) {
    await updateOpenInterest(context, conditionId, event.params.amount, blockNumber, blockTimestamp);
  }

  // PnL: Split = buying both outcomes at 50 cents each (skip NRA/Exchange)
  if (!SKIP_PNL.has(stakeholderLower)) {
    const positionIds = condition.positionIds;
    for (let i = 0; i < 2; i++) {
      await updateUserPositionWithBuy(
        context,
        stakeholder,
        positionIds[i]!,
        FIFTY_CENTS,
        event.params.amount,
        blockNumber,
        blockTimestamp,
      );
    }
  }
});

// ============================================================
// PositionsMerge — Activity + OI + PnL
// ============================================================

ConditionalTokens.PositionsMerge.handler(async ({ event, context }) => {
  const conditionId = event.params.conditionId;
  const stakeholder = event.params.stakeholder;
  const stakeholderLower = stakeholder.toLowerCase();
  const collateralToken = event.params.collateralToken;
  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

  const condition = await context.Condition.get(conditionId);
  if (!condition) return;

  // Activity: Create Merge (skip FPMMs, NegRiskAdapter, Exchange)
  if (!SKIP_ACTIVITY.has(stakeholderLower)) {
    const isFPMM = await context.FixedProductMarketMaker.get(stakeholder);
    if (!isFPMM) {
      context.Merge.set({
        id: getEventKey(event.chainId, event.block.number, event.logIndex),
        blockNumber,
        blockTimestamp,
        logIndex: event.logIndex,
        transactionHash: event.transaction.hash,
        timestamp: blockTimestamp,
        stakeholder,
        condition: conditionId,
        amount: event.params.amount,
      });
    }
  }

  // OI: Only track USDC merges
  if (collateralToken.toLowerCase() === USDC_LOWER) {
    await updateOpenInterest(context, conditionId, -event.params.amount, blockNumber, blockTimestamp);
  }

  // PnL: Merge = selling both outcomes at 50 cents each (skip NRA/Exchange)
  if (!SKIP_PNL.has(stakeholderLower)) {
    const positionIds = condition.positionIds;
    for (let i = 0; i < 2; i++) {
      await updateUserPositionWithSell(
        context,
        stakeholder,
        positionIds[i]!,
        FIFTY_CENTS,
        event.params.amount,
        blockNumber,
        blockTimestamp,
      );
    }
  }
});

// ============================================================
// PayoutRedemption — Activity + OI + PnL
// ============================================================

ConditionalTokens.PayoutRedemption.handler(async ({ event, context }) => {
  const conditionId = event.params.conditionId;
  const redeemer = event.params.redeemer;
  const collateralToken = event.params.collateralToken;
  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

  const condition = await context.Condition.get(conditionId);
  if (!condition) return;

  // Activity: Create Redemption (skip NegRiskAdapter)
  if (redeemer.toLowerCase() !== NEG_RISK_ADAPTER_LOWER) {
    context.Redemption.set({
      id: getEventKey(event.chainId, event.block.number, event.logIndex),
      blockNumber,
      blockTimestamp,
      logIndex: event.logIndex,
      transactionHash: event.transaction.hash,
      timestamp: blockTimestamp,
      redeemer,
      condition: conditionId,
      indexSets: event.params.indexSets.map((v: bigint) => v),
      payout: event.params.payout,
    });
  }

  // OI: Only track USDC redemptions
  if (collateralToken.toLowerCase() === USDC_LOWER) {
    await updateOpenInterest(context, conditionId, -event.params.payout, blockNumber, blockTimestamp);
  }

  // PnL: Redeem = sell at payout price (skip NRA — handled there)
  if (redeemer.toLowerCase() !== NEG_RISK_ADAPTER_LOWER) {
    if (condition.payoutDenominator === 0n) return;

    const payoutNumerators = condition.payoutNumerators;
    const payoutDenominator = condition.payoutDenominator;
    const positionIds = condition.positionIds;

    for (let i = 0; i < 2; i++) {
      const userPosition = await loadOrCreateUserPosition(
        context,
        redeemer,
        positionIds[i]!,
      );
      const amount = userPosition.amount;
      const price =
        (payoutNumerators[i]! * COLLATERAL_SCALE) / payoutDenominator;
      await updateUserPositionWithSell(
        context,
        redeemer,
        positionIds[i]!,
        price,
        amount,
        blockNumber,
        blockTimestamp,
      );
    }
  }
});

// ============================================================
// TransferSingle — ERC1155 share balance tracking
// ============================================================

ConditionalTokens.TransferSingle.handler(async ({ event, context }) => {
  const from = event.params.from;
  const to = event.params.to;
  const tokenId = event.params.id;
  const value = event.params.value;
  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

  // Decrease sender balance (skip zero address = mint)
  if (from !== ADDRESS_ZERO) {
    const fromId = `${from}-${tokenId}`;
    const fromBalance = await context.ShareBalance.get(fromId);
    context.ShareBalance.set({
      id: fromId,
      blockNumber,
      blockTimestamp,
      owner: from,
      tokenId,
      balance: (fromBalance?.balance ?? 0n) - value,
    });
  }

  // Increase receiver balance (skip zero address = burn)
  if (to !== ADDRESS_ZERO) {
    const toId = `${to}-${tokenId}`;
    const toBalance = await context.ShareBalance.get(toId);
    context.ShareBalance.set({
      id: toId,
      blockNumber,
      blockTimestamp,
      owner: to,
      tokenId,
      balance: (toBalance?.balance ?? 0n) + value,
    });
  }
});

// ============================================================
// TransferBatch — ERC1155 batch share balance tracking
// ============================================================

ConditionalTokens.TransferBatch.handler(async ({ event, context }) => {
  const from = event.params.from;
  const to = event.params.to;
  const ids = event.params.ids;
  const values = event.params.values;
  const blockNumber = BigInt(event.block.number);
  const blockTimestamp = BigInt(event.block.timestamp);

  for (let i = 0; i < ids.length; i++) {
    const tokenId = ids[i]!;
    const value = values[i]!;

    if (from !== ADDRESS_ZERO) {
      const fromId = `${from}-${tokenId}`;
      const fromBalance = await context.ShareBalance.get(fromId);
      context.ShareBalance.set({
        id: fromId,
        blockNumber,
        blockTimestamp,
        owner: from,
        tokenId,
        balance: (fromBalance?.balance ?? 0n) - value,
      });
    }

    if (to !== ADDRESS_ZERO) {
      const toId = `${to}-${tokenId}`;
      const toBalance = await context.ShareBalance.get(toId);
      context.ShareBalance.set({
        id: toId,
        blockNumber,
        blockTimestamp,
        owner: to,
        tokenId,
        balance: (toBalance?.balance ?? 0n) + value,
      });
    }
  }
});
