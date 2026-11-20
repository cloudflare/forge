// Expand/collapse-all is wired by the `[data-api-section]` wrapper that
// `ApiFieldList` renders, and hash links by `ApiBody`; used standalone,
// `ApiFieldRow` and `ApiUnionExplorer` still work as native `<details>`.
export { default as ApiFieldRow } from "./ApiFieldRow.astro";
export { default as ApiFieldList } from "./ApiFieldList.astro";
export { default as ApiUnionExplorer } from "./ApiUnionExplorer.astro";
