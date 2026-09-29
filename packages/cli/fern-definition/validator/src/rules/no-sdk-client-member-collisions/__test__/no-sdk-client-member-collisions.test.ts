import { AbsoluteFilePath, join, RelativeFilePath } from "@fern-api/fs-utils";
import { getViolationsForRule } from "../../../testing-utils/getViolationsForRule.js";
import { ValidationViolation } from "../../../ValidationViolation.js";
import { NoSdkClientMemberCollisionsRule } from "../no-sdk-client-member-collisions.js";

describe("no-sdk-client-member-collisions", () => {
    it("simple", async () => {
        const violations = await getViolationsForRule({
            rule: NoSdkClientMemberCollisionsRule,
            absolutePathToWorkspace: join(
                AbsoluteFilePath.of(__dirname),
                RelativeFilePath.of("fixtures"),
                RelativeFilePath.of("simple")
            )
        });

        const expectedViolations: ValidationViolation[] = [
            {
                message:
                    'Endpoint "fetch" and the root client passthrough method "fetch" both generate the SDK client member "fetch". The TypeScript SDK generator fails on this; rename one of them (for example with x-fern-sdk-method-name or x-fern-sdk-group-name).',
                nodePath: ["service", "endpoints", "fetch"],
                relativeFilepath: RelativeFilePath.of("__package__.yml"),
                name: "no-sdk-client-member-collisions",
                severity: "error"
            },
            {
                message:
                    'Endpoint "constants" and subpackage client "constants" both generate the SDK client member "constants". The TypeScript SDK generator fails on this; rename one of them (for example with x-fern-sdk-method-name or x-fern-sdk-group-name).',
                nodePath: ["service", "endpoints", "constants"],
                relativeFilepath: RelativeFilePath.of("requests.yml"),
                name: "no-sdk-client-member-collisions",
                severity: "error"
            }
        ];

        expect(violations).toEqual(expectedViolations);
    });
});
