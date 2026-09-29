import { visitAllDefinitionFiles } from "@fern-api/api-workspace-commons";
import { FERN_PACKAGE_MARKER_FILENAME_NO_EXTENSION } from "@fern-api/configuration-loader";
import { RelativeFilePath } from "@fern-api/fs-utils";
import { getCamelCaseUnsafe } from "@fern-api/ir-utils";

import { Rule } from "../../Rule.js";

// Mirrors the member names GeneratedSdkClientClassImpl assigns to a client class. The TypeScript
// generator throws when two of them match, so `fern check` flags the endpoints involved first.
// Packages merge by path, the same way the IR does: `a.yml`, `a/__package__.yml` and the `a/`
// directory are all package "a".
const OPTIONS_MEMBER = "_options";
const ROOT_FETCH_MEMBER = "fetch";

export const NoSdkClientMemberCollisionsRule: Rule = {
    name: "no-sdk-client-member-collisions",
    create: ({ workspace }) => {
        const endpointsByPackage = new Map<string, string[]>();
        visitAllDefinitionFiles(workspace, (relativeFilepath, file) => {
            const endpoints = Object.keys(file.service?.endpoints ?? {});
            if (endpoints.length === 0) {
                return;
            }
            const packageKey = getPackageKey(relativeFilepath);
            endpointsByPackage.set(packageKey, [...(endpointsByPackage.get(packageKey) ?? []), ...endpoints]);
        });

        // A subpackage only becomes a client member when something below it has endpoints.
        const childrenWithEndpoints = new Map<string, Set<string>>();
        for (const packageKey of endpointsByPackage.keys()) {
            const parts = splitPackageKey(packageKey);
            for (let i = 1; i <= parts.length; i++) {
                const parentKey = parts.slice(0, i - 1).join("/");
                const children = childrenWithEndpoints.get(parentKey) ?? new Set<string>();
                children.add(parts[i - 1] ?? "");
                childrenWithEndpoints.set(parentKey, children);
            }
        }

        const membersByPackage = new Map<string, Map<string, string[]>>();
        const getMembers = (packageKey: string): Map<string, string[]> => {
            const cached = membersByPackage.get(packageKey);
            if (cached != null) {
                return cached;
            }
            const members = new Map<string, string[]>();
            const add = (name: string, source: string) => members.set(name, [...(members.get(name) ?? []), source]);
            add(OPTIONS_MEMBER, "the client options property");
            if (packageKey === "") {
                add(ROOT_FETCH_MEMBER, 'the root client passthrough method "fetch"');
            }
            for (const endpointId of endpointsByPackage.get(packageKey) ?? []) {
                const methodName = camelCase(endpointId);
                add(methodName, `endpoint "${endpointId}"`);
                add(`__${methodName}`, `the internal method for endpoint "${endpointId}"`);
            }
            for (const child of childrenWithEndpoints.get(packageKey) ?? []) {
                const clientName = camelCase(child);
                add(clientName, `subpackage client "${child}"`);
                add(`_${clientName}`, `the cache for subpackage client "${child}"`);
            }
            membersByPackage.set(packageKey, members);
            return members;
        };

        return {
            definitionFile: {
                httpEndpoint: ({ endpointId }, { relativeFilepath }) => {
                    const members = getMembers(getPackageKey(relativeFilepath));
                    const methodName = camelCase(endpointId);
                    const self = [`endpoint "${endpointId}"`, `the internal method for endpoint "${endpointId}"`];
                    return [methodName, `__${methodName}`].flatMap((name) => {
                        const others = (members.get(name) ?? []).filter((source) => !self.includes(source));
                        if (others.length === 0) {
                            return [];
                        }
                        return [
                            {
                                severity: "error" as const,
                                message:
                                    `Endpoint "${endpointId}" and ${others.join(", ")} both generate the SDK client ` +
                                    `member "${name}". The TypeScript SDK generator fails on this; rename one of them ` +
                                    "(for example with x-fern-sdk-method-name or x-fern-sdk-group-name)."
                            }
                        ];
                    });
                }
            }
        };
    }
};

function getPackageKey(relativeFilepath: RelativeFilePath): string {
    const parts = relativeFilepath.replace(/\.ya?ml$/, "").split("/");
    if (parts.at(-1) === FERN_PACKAGE_MARKER_FILENAME_NO_EXTENSION) {
        parts.pop();
    }
    return parts.join("/");
}

function splitPackageKey(packageKey: string): string[] {
    return packageKey === "" ? [] : packageKey.split("/");
}

function camelCase(originalName: string): string {
    return getCamelCaseUnsafe(originalName);
}
