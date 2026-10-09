import { FullExample, PrimitiveExample } from "@fern-api/openapi-ir";
import { describe, expect, it } from "vitest";

import { convertToFullExample } from "../convertToFullExample.js";

// FullExample values carry _visit functions, so compare their JSON shape.
function plain(value: unknown): unknown {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

describe("convertToFullExample", () => {
    it("keeps empty arrays and nulls in an authored error body", () => {
        const result = convertToFullExample({
            success: false,
            errors: [{ code: 1001, message: "Missing required parameter: q" }],
            messages: [],
            result: null
        });

        expect(plain(result)).toEqual(
            plain(
                FullExample.map([
                    {
                        key: PrimitiveExample.string("success"),
                        value: FullExample.primitive(PrimitiveExample.boolean(false))
                    },
                    {
                        key: PrimitiveExample.string("errors"),
                        value: FullExample.array([
                            FullExample.map([
                                {
                                    key: PrimitiveExample.string("code"),
                                    value: FullExample.primitive(PrimitiveExample.int(1001))
                                },
                                {
                                    key: PrimitiveExample.string("message"),
                                    value: FullExample.primitive(
                                        PrimitiveExample.string("Missing required parameter: q")
                                    )
                                }
                            ])
                        ])
                    },
                    {
                        key: PrimitiveExample.string("messages"),
                        value: FullExample.array([])
                    },
                    {
                        key: PrimitiveExample.string("result"),
                        value: FullExample.null({})
                    }
                ])
            )
        );
    });

    it("keeps a top-level empty array", () => {
        expect(plain(convertToFullExample([]))).toEqual(plain(FullExample.array([])));
    });

    it("keeps null array items", () => {
        expect(plain(convertToFullExample([null]))).toEqual(plain(FullExample.array([FullExample.null({})])));
    });

    it("returns undefined for undefined", () => {
        expect(convertToFullExample(undefined)).toBeUndefined();
    });
});
