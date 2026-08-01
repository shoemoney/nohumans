#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  process.exitCode = await main();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
