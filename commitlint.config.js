/**
 * Conventional Commits. With squash merges the pull request title becomes the
 * commit on `main`, so CI validates PR titles with this same configuration.
 *
 * @type {import('@commitlint/types').UserConfig}
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 72],
  },
  // Dependabot titles ("<type>(deps): bump <package> from <a> to <b>") are
  // generated, conventional by construction and may exceed 72 characters.
  ignores: [(message) => /^(build|chore|ci|fix)\(deps(-dev)?\): bump /.test(message)],
};
