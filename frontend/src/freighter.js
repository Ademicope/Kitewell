import {
  isConnected,
  setAllowed,
  getAddress,
  signTransaction,
} from "@stellar/freighter-api";
import * as StellarSdk from "@stellar/stellar-sdk";
import { HORIZON_URL } from "./stellar";
import { API_BASE } from "./config";

const server = new StellarSdk.Horizon.Server(HORIZON_URL);
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

export async function checkFreighterInstalled() {
  const result = await isConnected();
  return result.isConnected;
}

export async function connectFreighterWallet() {
  const installed = await isConnected();
  if (!installed.isConnected) {
    throw new Error(
      "Freighter is not installed. Get it from freighter.app, set Testnet, then refresh."
    );
  }

  const permission = await setAllowed();
  if (!permission.isAllowed) {
    throw new Error("Connection denied. Allow Kitewell in Freighter to continue.");
  }

  const addressResult = await getAddress();
  if (addressResult.error || !addressResult.address) {
    throw new Error(
      addressResult.error?.message || "Could not read the address from Freighter."
    );
  }

  return addressResult.address;
}

async function signAndSubmit(transaction, publicKey) {
  const unsignedXdr = transaction.toXDR();
  const signResult = await signTransaction(unsignedXdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: publicKey,
  });

  if (signResult.error || !signResult.signedTxXdr) {
    throw new Error(
      signResult.error?.message || "Transaction signing was rejected in Freighter."
    );
  }

  const signedTx = StellarSdk.TransactionBuilder.fromXDR(
    signResult.signedTxXdr,
    NETWORK_PASSPHRASE
  );

  return server.submitTransaction(signedTx);
}

export async function sendPaymentWithFreighter(
  publicKey,
  destination,
  amount,
  memo = ""
) {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(destination)) {
    throw new Error("Destination must be a valid Stellar public key (G…).");
  }

  const sourceAccount = await server.loadAccount(publicKey);
  const txBuilder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(
    StellarSdk.Operation.payment({
      destination,
      asset: StellarSdk.Asset.native(),
      amount: amount.toString(),
    })
  );

  if (memo) {
    txBuilder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));
  }

  const transaction = txBuilder.setTimeout(180).build();
  return signAndSubmit(transaction, publicKey);
}

export async function getBuilder(address) {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(address)) {
    throw new Error("Address must be a valid Stellar public key (G…).");
  }
  try {
    const res = await fetch(`${API_BASE}/api/builder/${address}`);
    if (!res.ok) throw new Error("Builder fetch failed");
    const data = await res.json();
    return data.builder || null;
  } catch {
    // Fall back to Horizon lookup - check if address has a home_domain (registered builder)
    const account = await server.loadAccount(address);
    return account.home_domain
      ? { name: account.home_domain, address }
      : null;
  }
}

/**
 * Establish or raise a trustline for a credit asset on Testnet.
 * limit "0" removes the trustline (when balance is zero).
 */
export async function changeTrustWithFreighter(
  publicKey,
  assetCode,
  assetIssuer,
  limit = "1000000"
) {
  if (!assetCode || assetCode.length > 12) {
    throw new Error("Asset code must be 1–12 characters.");
  }
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(assetIssuer)) {
    throw new Error("Issuer must be a valid Stellar public key (G…).");
  }

  const asset = new StellarSdk.Asset(assetCode.toUpperCase(), assetIssuer);
  const sourceAccount = await server.loadAccount(publicKey);
  const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset,
        limit: limit.toString(),
      })
    )
    .setTimeout(180)
    .build();

  return signAndSubmit(transaction, publicKey);
}
