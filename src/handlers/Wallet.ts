import { RelayHub, SafeProxyFactory, USDC } from "generated";
import {
  PROXY_WALLET_FACTORY,
  PROXY_WALLET_IMPLEMENTATION,
} from "../utils/constants.js";
import { computeProxyWalletAddress } from "../utils/wallet.js";

const GLOBAL_USDC_ID = "global";

// ============================================================
// RelayHub — proxy wallet creation
// ============================================================

RelayHub.TransactionRelayed.handler(async ({ event, context }) => {
  const from = event.params.from;
  const to = event.params.to;

  // Only process calls to the proxy wallet factory
  if (to.toLowerCase() !== PROXY_WALLET_FACTORY.toLowerCase()) {
    return;
  }

  const walletAddress = computeProxyWalletAddress(
    from as `0x${string}`,
    PROXY_WALLET_FACTORY as `0x${string}`,
    PROXY_WALLET_IMPLEMENTATION as `0x${string}`,
  );

  const existing = await context.Wallet.get(walletAddress);
  if (!existing) {
    context.Wallet.set({
      id: walletAddress,
      signer: from,
      type: "proxy",
      balance: 0n,
      lastTransfer: 0n,
      createdAt: BigInt(event.block.timestamp),
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
    });
  }
});

// ============================================================
// SafeProxyFactory — safe wallet creation
// ============================================================

SafeProxyFactory.ProxyCreation.handler(async ({ event, context }) => {
  const proxyAddress = event.params.proxy;

  const existing = await context.Wallet.get(proxyAddress);
  if (!existing) {
    context.Wallet.set({
      id: proxyAddress,
      signer: event.params.owner,
      type: "safe",
      balance: 0n,
      lastTransfer: 0n,
      createdAt: BigInt(event.block.timestamp),
      blockNumber: BigInt(event.block.number),
      blockTimestamp: BigInt(event.block.timestamp),
    });
  }
});

// ============================================================
// USDC Transfer — wallet balance tracking
// ============================================================

USDC.Transfer.handler(async ({ event, context }) => {
  const from = event.params.from;
  const to = event.params.to;
  const amount = event.params.amount;
  const timestamp = BigInt(event.block.timestamp);
  const blockNumber = BigInt(event.block.number);

  // Check receiver
  const toWallet = await context.Wallet.get(to);
  if (toWallet) {
    context.Wallet.set({
      ...toWallet,
      balance: toWallet.balance + amount,
      lastTransfer: timestamp,
      blockNumber,
      blockTimestamp: timestamp,
    });

    // Update global balance
    const global = await context.GlobalUSDCBalance.get(GLOBAL_USDC_ID);
    if (global) {
      context.GlobalUSDCBalance.set({
        ...global,
        balance: global.balance + amount,
        blockNumber,
        blockTimestamp: timestamp,
      });
    } else {
      context.GlobalUSDCBalance.set({
        id: GLOBAL_USDC_ID,
        balance: amount,
        blockNumber,
        blockTimestamp: timestamp,
      });
    }
  }

  // Check sender
  const fromWallet = await context.Wallet.get(from);
  if (fromWallet) {
    context.Wallet.set({
      ...fromWallet,
      balance: fromWallet.balance - amount,
      lastTransfer: timestamp,
      blockNumber,
      blockTimestamp: timestamp,
    });

    // Update global balance
    const global = await context.GlobalUSDCBalance.get(GLOBAL_USDC_ID);
    if (global) {
      context.GlobalUSDCBalance.set({
        ...global,
        balance: global.balance - amount,
        blockNumber,
        blockTimestamp: timestamp,
      });
    } else {
      context.GlobalUSDCBalance.set({
        id: GLOBAL_USDC_ID,
        balance: 0n - amount,
        blockNumber,
        blockTimestamp: timestamp,
      });
    }
  }
});
