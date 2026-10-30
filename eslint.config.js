import tseslint from 'typescript-eslint';
export default tseslint.config(
  {ignores:['dist/**','dist-extension/**','dist-extension-v3/**','dist-native-host/**','dist-p01-owner-v3-kit/**','node_modules/**','coverage/**','.worktrees/**','.cocwin-worktrees/**','.superpowers/**']},
  ...tseslint.configs.recommended,
  {files:['**/*.ts'],languageOptions:{parserOptions:{tsconfigRootDir:import.meta.dirname}},rules:{'@typescript-eslint/no-explicit-any':'error'}},
);
