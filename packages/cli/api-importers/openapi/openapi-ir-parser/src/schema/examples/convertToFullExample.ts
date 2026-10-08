import { FullExample, KeyValuePair, PrimitiveExample } from "@fern-api/openapi-ir";

/**
 * Converts an authored example value into a FullExample without consulting a schema.
 *
 * Empty arrays and nulls are values the author wrote, so they are kept. Only
 * `undefined` and values that have no JSON representation produce `undefined`.
 */
export function convertToFullExample(value: unknown): FullExample | undefined {
    if (value === null) {
        return FullExample.null({});
    } else if (typeof value === "string") {
        return FullExample.primitive(PrimitiveExample.string(value));
    } else if (typeof value === "number") {
        if (Number.isInteger(value)) {
            return FullExample.primitive(PrimitiveExample.int(value));
        }
        return FullExample.primitive(PrimitiveExample.double(value));
    } else if (typeof value === "boolean") {
        return FullExample.primitive(PrimitiveExample.boolean(value));
    } else if (Array.isArray(value)) {
        const examples: FullExample[] = [];
        for (const item of value) {
            const itemExample = convertToFullExample(item);
            if (itemExample != null) {
                examples.push(itemExample);
            }
        }
        return FullExample.array(examples);
    } else if (
        value != null &&
        typeof value === "object" &&
        Object.keys(value).every((key) => typeof key === "string")
    ) {
        const kvs: KeyValuePair[] = [];
        for (const [property, propertyValue] of Object.entries(value)) {
            const propertyExample = convertToFullExample(propertyValue);
            if (propertyExample != null) {
                kvs.push({
                    key: PrimitiveExample.string(property),
                    value: propertyExample
                });
            }
        }
        return FullExample.map(kvs);
    }
    return undefined;
}
