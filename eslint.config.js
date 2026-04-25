import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["node_modules/", "coverage/", "data/", "dist/"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
  },
  {
    files: ["src/sources/**/*.ts", "src/sync/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "Use the injected FetchLike, wrapped via createFetchWithTimeout. Bare fetch hangs forever and has wedged the server in prod.",
        },
      ],
    },
  },
];
