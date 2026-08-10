/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  testTimeout: 10000,
  forceExit: true,
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
};
