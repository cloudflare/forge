import { CliEnvironment } from "../CliEnvironment.js";

// Cloudflare fork: this CLI keeps upstream's package name (`fern-api`) but is
// vendored, never installed from npm. `latest` on npm is upstream's build, so
// report this build as the latest: no upgrade notices, no registry lookups.
export async function getLatestVersionOfCli({
    cliEnvironment
}: {
    cliEnvironment: CliEnvironment;
    includePreReleases?: boolean;
}): Promise<string> {
    return cliEnvironment.packageVersion;
}
