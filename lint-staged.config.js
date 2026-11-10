/** @type {import('lint-staged').Configuration} */
export default {
  '*.{ts,js}': ['eslint --max-warnings=0 --fix', 'prettier --write'],
  '*.{json,md,yml,yaml}': 'prettier --write',
};
