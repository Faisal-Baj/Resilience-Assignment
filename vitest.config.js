// Settings for the automated tests (`npm test`).
import 'dotenv/config';
import { defineConfig } from 'vitest/config';

// The tests delete all data in their database before each test,
// so they must never run against the normal database.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl || testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL in .env to a separate database (see .env.example).');
}

export default defineConfig({
  test: {
    env: { DATABASE_URL: testDatabaseUrl }, // the app under test talks to the test database
    globalSetup: './tests/global-setup.js', // applies the migrations to the test database once
    fileParallelism: false, // the test files share one database, so they run one after another
  },
});
