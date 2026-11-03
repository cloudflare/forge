# Installing the native Forge binary

Every Forge release publishes a native archive for macOS, Linux and Windows on
arm64 and x64. The Linux executables are statically linked and work in glibc and
musl images, including Alpine. A release also contains `SHA256SUMS` and the
`@cloudflare/forge` npm tarball. All of them are built from the release tag with
the same Forge version.

## Install and verify

Choose a version and platform from the [Forge releases](https://github.com/cloudflare/forge/releases).
The platform names are `darwin-arm64`, `darwin-x64`, `linux-arm64`,
`linux-x64`, `win32-arm64` and `win32-x64`.

For Linux x64:

```sh
version=0.1.0
asset="forge-${version}-linux-x64.tar.gz"
base="https://github.com/cloudflare/forge/releases/download/v${version}"

curl -fsSLO "${base}/${asset}"
curl -fsSLO "${base}/SHA256SUMS"
grep "  ${asset}$" SHA256SUMS | sha256sum --check
tar -xzf "${asset}"
install "forge-${version}-linux-x64/forge" /usr/local/bin/forge
forge --version
```

On macOS, use `shasum -a 256 --check` instead of `sha256sum --check`. Keep the
checksum verification in automated builds: a successful download alone does not
verify the executable.

## Go service container

A Go service does not need a Go wrapper or Node. Install the executable in a
build stage, verify it, and copy it into the service image:

```dockerfile
FROM alpine:3.22 AS forge
ARG FORGE_VERSION=0.1.0
ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in amd64) forge_arch=x64 ;; arm64) forge_arch=arm64 ;; *) exit 1 ;; esac; \
    asset="forge-${FORGE_VERSION}-linux-${forge_arch}.tar.gz"; \
    base="https://github.com/cloudflare/forge/releases/download/v${FORGE_VERSION}"; \
    wget "${base}/${asset}" "${base}/SHA256SUMS"; \
    grep "  ${asset}$" SHA256SUMS | sha256sum -c -; \
    tar -xzf "$asset"; \
    install "forge-${FORGE_VERSION}-linux-${forge_arch}/forge" /usr/local/bin/forge

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY . .
RUN go build -o /out/service ./cmd/service

FROM alpine:3.22
COPY --from=forge /usr/local/bin/forge /usr/local/bin/forge
COPY --from=build /out/service /usr/local/bin/service
ENTRYPOINT ["service"]
```

Invoke Forge as a normal subprocess, for example:

```go
cmd := exec.CommandContext(ctx, "forge", "normalize", "--write", "openapi.json")
cmd.Stdout = os.Stdout
cmd.Stderr = os.Stderr
if err := cmd.Run(); err != nil {
	return fmt.Errorf("normalize OpenAPI document: %w", err)
}
```

## Discover and upgrade versions

[GitHub Releases](https://github.com/cloudflare/forge/releases/latest) is the
source of released versions and release notes. Automation can read the latest
tag with:

```sh
gh release view --repo cloudflare/forge --json tagName --jq .tagName
```

Pin `FORGE_VERSION` rather than downloading `latest`. To upgrade, change that
pin, rebuild the image, and let the build fetch and verify the checksum published
with the new release.

## Migrate from the npm preview package

For a non-Node service currently installing the `pkg.pr.new` preview package
only to reach `native/linux-*/forge`:

1. Choose the first Forge release containing the command the service uses.
2. Replace the Node/npm installation and package-path lookup with the verified
   release download shown above.
3. Invoke `forge` from `PATH`; command arguments do not change. For example,
   `node_modules/.bin/forge normalize ...` becomes `forge normalize ...`.
4. Remove the `@cloudflare/forge` dependency, npm lockfile changes and Node build
   tooling if nothing else needs them.
5. Pin the release version in the image and update it through normal dependency
   upgrades.

The npm package and the standalone binary in a given release contain the same
native executable, so this migration changes distribution, not Forge behavior.
