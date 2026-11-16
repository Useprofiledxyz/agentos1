// npm run token -- [label] [--owner 0x…] [--execute] [--live]
// Creates an API token for REST/MCP. Printed once; only its hash is stored.
import { createToken, setToken } from "../src/apitokens.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const ownerIdx = args.indexOf("--owner");
const owner = ownerIdx >= 0 ? args[ownerIdx + 1] : null;
const label = args.find((a, i) => !a.startsWith("--") && i !== ownerIdx + 1) || "token";
const scopes = flag("--execute") ? ["prepare", "execute"] : ["prepare"];
const t = await createToken({ label, owner, scopes });
if (flag("--live")) await setToken(t.id, { dryRun: false });
console.log(`token:  ${t.token}\nid:     ${t.id}\nscopes: ${scopes.join(", ")}\ndryRun: ${!flag("--live")}\nKeep it secret; it is not shown again.`);
