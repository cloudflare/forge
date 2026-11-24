import { defineCollection } from "astro:content";
// `z` re-exported from `astro:content` is deprecated; import it from
// `astro/zod` (the pattern nimbus-docs' own schema helpers document).
import { z } from "astro/zod";
import { docsCollection, partialsCollection } from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(
    docsCollection({
      schemaFields: {
        // Nimbus docs are agent-friendly by default. Set `audience: human`
        // to flag a page that's written primarily for human readers.
        audience: z.literal("human").optional(),
        // What kind of page this is, from the Cloudflare docs style guide's
        // content types: https://developers.cloudflare.com/style-guide/documentation-content-strategy/content-types/
        content_type: z.enum([
          "overview",
          "get-started",
          "how-to",
          "concept",
          "reference",
          "troubleshooting",
        ]),
      },
    }),
  ),
  partials: defineCollection(partialsCollection()),
};
