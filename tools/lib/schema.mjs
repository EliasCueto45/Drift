import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemaPath = new URL("../../packages/contracts/schemas/drift.schema.json", import.meta.url);
export const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schema);

/** Returns (value) => {ok, errors[]} for a named definition, e.g. "TrackingBatch". */
export function validator(defName) {
  if (!schema.$defs[defName]) throw new Error(`Unknown contract definition: ${defName}`);
  const fn = ajv.compile({ $ref: `${schema.$id}#/$defs/${defName}` });
  return (value) => {
    const ok = fn(value);
    return { ok, errors: ok ? [] : fn.errors.map((e) => `${e.instancePath || "/"} ${e.message}`) };
  };
}
