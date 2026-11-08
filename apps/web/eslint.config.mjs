import next from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...next,
  ...nextTs,
  { ignores: [".next/**", "node_modules/**", "src/server/**", "next-env.d.ts", "src/lib/contracts/generated.ts"] },
];

export default config;
