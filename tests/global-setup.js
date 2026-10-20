// Runs once before all the tests: creates the test database if needed and applies our migrations,
// so it has the same tables as the real one.
import 'dotenv/config';
import { execSync } from 'node:child_process';

export default function setup() {
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
    stdio: 'pipe', // quiet unless it fails
  });
}
