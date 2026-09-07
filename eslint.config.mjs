import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["node_modules/", "dist/", "coverage/"] },
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			"no-console": "warn",
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
);
