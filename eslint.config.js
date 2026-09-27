import tseslint from 'typescript-eslint';
export default tseslint.config(
  {ignores:['dist/**','node_modules/**','coverage/**','.worktrees/**','.superpowers/**']},
  ...tseslint.configs.recommended,
  {files:['**/*.ts'],languageOptions:{parserOptions:{tsconfigRootDir:import.meta.dirname}},rules:{'@typescript-eslint/no-explicit-any':'error'}},
);
