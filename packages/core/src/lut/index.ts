/**
 * 3D LUT sub-API: the table type, baking, trilinear lookup and `.cube` I/O.
 *
 * Re-export only; the implementations live in the sibling files.
 */

export * from "./table.js";
export * from "./bake.js";
export * from "./apply.js";
export * as cube from "./cube.js";
