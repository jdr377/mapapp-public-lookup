import type { Advertiser, Engine } from "@bsv/overlay";
import { WalletAdvertiser } from "@bsv/overlay-discovery-services";
import { DEFAULT_SLAP_TRACKERS } from "@bsv/sdk";

export function createOverlayAdvertiser(config: {
  advertisingEnabled: boolean; advertisingFunded: boolean;
  rootHex: string; walletStorageUrl: string; advertisedOrigin: string;
}, args: string[]) {
  if (!config.advertisingEnabled) {
    if (args.length > 0) throw Error("overlay_command_arguments_invalid");
    return undefined;
  }
  if (!config.advertisingFunded) throw Error("overlay_advertising_requires_funded_operator_attestation");
  if (args.length !== 1 || args[0] !== "--confirm-mainnet") throw Error("overlay_mainnet_confirmation_required");
  // Include retained local ads for explicit operator maintenance. Serving never
  // reconciles ads: stock lookup failures can otherwise look like missing ads.
  return new WalletAdvertiser("main", config.rootHex, config.walletStorageUrl, config.advertisedOrigin, {
    slapTrackers: [...DEFAULT_SLAP_TRACKERS, config.advertisedOrigin],
    additionalHosts: { ls_ship: [config.advertisedOrigin] },
  });
}

export async function startOverlayHost(host: { start(): Promise<void>; engine?: Engine },
  advertiser?: Advertiser & { init(): Promise<void> }) {
  const engine = host.engine;
  if (!engine) throw Error("overlay_engine_unavailable");
  // A discovery outage during startup must never cause advertisement funding.
  if (advertiser) engine.advertiser = undefined;
  const peers = engine.syncConfiguration;
  engine.syncConfiguration = {};
  try { await host.start(); }
  finally {
    if (advertiser) engine.advertiser = advertiser;
    engine.syncConfiguration = peers;
  }
  await advertiser?.init();
  try { await engine.startGASPSync(); }
  catch { console.warn("OVERLAY_GASP status=unavailable; serving retained records"); }
}
