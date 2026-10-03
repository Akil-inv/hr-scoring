module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  // Modules, type definitions and the entry point are declarative. Measuring
  // them reports a coverage number that says nothing about what is tested.
  collectCoverageFrom: [
    '**/*.(t|j)s',
    '!**/*.module.ts',
    '!**/*.types.ts',
    '!**/main.ts',
    '!**/*.spec.ts',
  ],
  coverageDirectory: '../coverage',
  // text for a human reading the terminal, lcov and cobertura because that is
  // what every coverage tool looks for. Without them coverage is collected and
  // then reported as zero by anything downstream.
  coverageReporters: ['text-summary', 'lcov', 'cobertura'],
  testEnvironment: 'node',
};
