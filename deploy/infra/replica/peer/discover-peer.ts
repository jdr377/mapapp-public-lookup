import { DEFAULT_SLAP_TRACKERS, LookupResolver, Transaction } from "@bsv/sdk";
import { decodeAndVerifyOverlayAdvertisement } from "@bsv/sdk/overlay-tools/OverlayAdminTokenTemplate";

const resolver = new LookupResolver();
const topic = "tm_mapapp";
const lookup = "ls_mapapp";

async function discover(protocol: "SHIP" | "SLAP", name: string) {
  const answer = await resolver.query({
    service: protocol === "SHIP" ? "ls_ship" : "ls_slap",
    query: protocol === "SHIP" ? { topics: [name] } : { service: name },
  }, 10_000, { waitForAllHosts: true });
  if (answer.type !== "output-list") throw Error(`Unexpected ${protocol} answer`);
  const advertisements = [];
  for (const output of answer.outputs) {
    try {
      const transaction = Transaction.fromBEEF(output.beef);
      const script = transaction.outputs[output.outputIndex]?.lockingScript;
      if (!script) continue;
      const signed = await decodeAndVerifyOverlayAdvertisement(script, protocol);
      const url = new URL(signed.domain);
      if (signed.topicOrService !== name || url.protocol !== "https:" ||
        url.href !== url.origin + "/" || url.port ||
        !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
        /\.(local|localhost|internal|home|lan|test|invalid)$/i.test(url.hostname)) continue;
      advertisements.push({
        origin: url.origin,
        identityKey: signed.identityKey,
        outpoint: `${transaction.id("hex")}.${output.outputIndex}`,
      });
    } catch {
      // Trackers can return unrelated or unauthenticated outputs.
    }
  }
  return { returned: answer.outputs.length, advertisements };
}

const [ship, slap] = await Promise.all([
  discover("SHIP", topic),
  discover("SLAP", lookup),
]);
const commonOrigins = [...new Set(ship.advertisements.filter(topic => slap.advertisements.some(lookup =>
  lookup.origin === topic.origin && lookup.identityKey === topic.identityKey,
)).map(topic => topic.origin))].sort();
const evidence = { trackers: DEFAULT_SLAP_TRACKERS, ship, slap, commonOrigins };
if (process.argv.includes("--select")) {
  // This Docker client sends only a credential-free capability probe.
  // A directory advertisement is not a claim of snapshot compatibility.
  for (const origin of commonOrigins.slice(0, 8)) {
    try {
      const response = await fetch(origin + "/snapshot", {
        method: "HEAD", redirect: "error", signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200 ||
        !response.headers.get("content-type")?.includes("application/json")) continue;
      console.error(JSON.stringify({ ...evidence, selectedOrigin: origin }, null, 2));
      console.log(origin);
      process.exit(0);
    } catch {
      // Try the next advertised origin when the endpoint is unreachable.
    }
  }
  console.error(JSON.stringify({ ...evidence, selectedOrigin: null }, null, 2));
  console.error(`No discovered ${topic}/${lookup} peer serves a compatible /snapshot endpoint.`);
  process.exit(1);
}
console.log(JSON.stringify(evidence, null, 2));
